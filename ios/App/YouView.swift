import PhotosUI
import SwiftUI

/// "You": what Rizzio has learned about you, and ways to teach it.
struct YouView: View {
    @State private var me: MeResponse?
    @State private var aboutMe = ""
    @State private var examplesText = ""
    @State private var teachItems: [PhotosPickerItem] = []
    @State private var status: String?
    @State private var errorMessage: String?
    @State private var isBusy = false
    @State private var confirmReset = false

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                Section {
                    if let me, !me.voiceProfile.isEmpty {
                        Text(me.voiceProfile).font(.callout)
                    } else {
                        Text("Nothing learned yet. Add a few of your messages below, or teach Rizzio with screenshots of your chats.")
                            .foregroundStyle(.secondary)
                    }
                    Button("Re-learn now") { Task { await rebuild() } }.disabled(isBusy)
                } header: {
                    Text("How you text")
                } footer: {
                    if let me {
                        Text("Learned from \(me.stats.examples) of your messages, \(me.stats.picks) picks and \(me.stats.wins) wins. It updates itself as you use Rizzio.")
                    }
                }

                Section {
                    PhotosPicker(selection: $teachItems, maxSelectionCount: 10, matching: .screenshots) {
                        Label("Teach from chat screenshots", systemImage: "text.bubble")
                    }
                    if isBusy, let status { HStack { ProgressView(); Text(status) } }
                } header: {
                    Text("Teach Rizzio")
                } footer: {
                    Text("Pick screenshots of conversations where you were at your best (Hinge, iMessage, anything). Rizzio reads only your own messages, the ones on the right.")
                }

                Section {
                    TextField("e.g. 27, NYC, nurse, into climbing and cooking, dry humor", text: $aboutMe, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("About you")
                }

                Section {
                    TextField("One message per line", text: $examplesText, axis: .vertical)
                        .lineLimit(4...12)
                    Button("Save") { Task { await save() } }.disabled(isBusy)
                } header: {
                    Text("Messages that worked for you")
                } footer: {
                    Text("Paste comments or texts you've sent that got matches or great replies.")
                }

                if let learned = me?.learnedExamples, !learned.isEmpty {
                    Section {
                        ForEach(learned) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.text)
                                Text(label(for: item.source)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .onDelete { offsets in
                            let ids = offsets.map { learned[$0].id }
                            Task { await delete(ids) }
                        }
                    } header: {
                        Text("What Rizzio learned from you")
                    } footer: {
                        Text("Swipe left to remove anything that isn't you.")
                    }
                }

                Section {
                    Button("Forget everything learned", role: .destructive) { confirmReset = true }
                } footer: {
                    Text("Keeps your About you and the messages you typed above.")
                }
            }
            .navigationTitle("You")
            .task { await load() }
            .refreshable { await load() }
            .onChange(of: teachItems) { items in
                guard !items.isEmpty else { return }
                Task { await teach(items) }
            }
            .confirmationDialog("Forget everything Rizzio learned?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Forget", role: .destructive) { Task { await reset() } }
            }
        }
    }

    private func label(for source: String) -> String {
        switch source {
        case "won": return "🏆 Got a match or reply"
        case "edited": return "✏️ Your rewrite"
        case "imported": return "From your chats"
        case "picked": return "You picked this"
        default: return source
        }
    }

    @MainActor private func load() async {
        do {
            let me = try await RizzAPI.me()
            self.me = me
            aboutMe = me.aboutMe
            examplesText = me.styleExamples.joined(separator: "\n")
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor private func save() async {
        await busy("Saving and re-learning…") {
            let examples = examplesText.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            try await RizzAPI.updateMe(aboutMe: aboutMe, styleExamples: examples)
            _ = try await RizzAPI.rebuildProfile()
        }
    }

    @MainActor private func teach(_ items: [PhotosPickerItem]) async {
        var learnedCount = 0
        await busy("Reading your chats…") {
            for (i, item) in items.enumerated() {
                status = "Reading screenshot \(i + 1) of \(items.count)…"
                guard let data = try await item.loadTransferable(type: Data.self),
                      let jpeg = ImageTools.compressedJPEG(from: data) else { continue }
                learnedCount += try await RizzAPI.learn(fromScreenshot: jpeg).count
            }
            status = "Updating your voice…"
            _ = try await RizzAPI.rebuildProfile()
        }
        teachItems = []
        if errorMessage == nil {
            errorMessage = learnedCount == 0 ? "Couldn't find any of your messages in those screenshots." : nil
        }
    }

    @MainActor private func rebuild() async {
        await busy("Re-learning your voice…") { _ = try await RizzAPI.rebuildProfile() }
    }

    @MainActor private func delete(_ ids: [Int]) async {
        await busy("Removing…") { for id in ids { try await RizzAPI.deleteExample(id: id) } }
    }

    @MainActor private func reset() async {
        await busy("Forgetting…") { try await RizzAPI.resetMemory() }
    }

    @MainActor private func busy(_ message: String, _ work: () async throws -> Void) async {
        isBusy = true
        status = message
        errorMessage = nil
        do { try await work() } catch { errorMessage = error.localizedDescription }
        isBusy = false
        status = nil
        await load()
    }
}
