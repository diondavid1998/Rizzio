import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// "Train": upload your chats and messages so Rizzio learns how you talk.
struct TrainView: View {
    @State private var me: MeResponse?
    @State private var aboutMe = ""
    @State private var examplesText = ""
    @State private var uploadItems: [PhotosPickerItem] = []
    @State private var uploads: [UploadResult] = []
    @State private var progress: String?
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var isBusy = false
    @State private var confirmReset = false

    /// One line per upload in "Just learned": a summary, not every message (exports can be huge).
    struct UploadResult: Identifiable {
        let id = UUID()
        let title: String
        let icon: String
        let count: Int
    }

    /// An exported chat waiting for you to say which sender is you.
    struct PendingImport: Identifiable {
        let filename: String
        let preview: ImportPreview
        var id: String { preview.importId }
    }

    @State private var showFileImporter = false
    @State private var choosing: PendingImport?
    @State private var importQueue: [PendingImport] = []
    @State private var importedThisRound = 0

    /// Rough "how well does Rizzio know you" meter: real messages count most, wins count extra.
    private var voiceMatch: Double {
        guard let stats = me?.stats else { return 0 }
        let score = Double(stats.examples) * 3 + Double(stats.wins) * 8 + Double(stats.picks)
        return min(score, 100)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                Section {
                    VoiceMatchCard(score: voiceMatch, stats: me?.stats)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                // MARK: Upload
                Section {
                    PhotosPicker(selection: $uploadItems, maxSelectionCount: 20, matching: .screenshots) {
                        HStack(spacing: 14) {
                            Image(systemName: "photo.on.rectangle")
                                .font(.title2)
                                .foregroundStyle(Theme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Upload chat screenshots").font(.headline)
                                Text("Up to 20 at a time: Hinge, iMessage, Instagram, anything")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    .disabled(isBusy)
                    Button { showFileImporter = true } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "doc.text")
                                .font(.title2)
                                .foregroundStyle(Theme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Import from Files").font(.headline).foregroundStyle(Theme.ink)
                                Text("Chat exports: WhatsApp, Instagram, Messenger, Telegram, Hinge, Tinder, CSV, JSON, TXT, zip, or images")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    .disabled(isBusy)
                    if let progress {
                        HStack { ProgressView(); Text(progress).font(.callout) }
                    }
                } header: {
                    Text("Upload data")
                } footer: {
                    Text("Rizzio only learns from your messages, not theirs: the right-hand bubbles in screenshots, or the sender you pick in an export. Files and screenshots aren't stored, only your messages.")
                }

                if !uploads.isEmpty {
                    Section("Just learned") {
                        ForEach(uploads.prefix(10)) { upload in
                            HStack {
                                Label(upload.title, systemImage: upload.icon).lineLimit(1)
                                Spacer()
                                Text(upload.count == 0 ? "none found" : "\(upload.count) messages")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                // MARK: Messages
                Section {
                    TextField("One message per line", text: $examplesText, axis: .vertical)
                        .accessibilityIdentifier("examples")
                        .lineLimit(4...12)
                    Button("Save messages") { Task { await saveText() } }.disabled(isBusy)
                } header: {
                    Text("Messages that worked")
                } footer: {
                    Text("Paste comments or texts you've sent that got matches or great replies. These count the most.")
                }

                Section {
                    TextField("e.g. 27, NYC, nurse, into climbing and cooking, dry humor", text: $aboutMe, axis: .vertical)
                        .accessibilityIdentifier("aboutMe")
                        .lineLimit(2...5)
                    Button("Save") { Task { await saveText() } }.disabled(isBusy)
                } header: {
                    Text("About you")
                } footer: {
                    Text("Facts Rizzio can use in replies: job, city, hobbies, your kind of humor.")
                }

                // MARK: What it knows
                Section {
                    if let profile = me?.voiceProfile, !profile.isEmpty {
                        Text(profile).font(.callout)
                    } else {
                        Text("Nothing yet. Upload a few chats above.").foregroundStyle(.secondary)
                    }
                    Button("Re-learn now") { Task { await busy("Re-learning your texting style…", done: "Updated how Rizzio thinks you text.") { _ = try await RizzAPI.rebuildProfile() } } }
                        .disabled(isBusy)
                } header: {
                    Text("How Rizzio thinks you talk")
                } footer: {
                    Text("Rizzio writes this itself and updates it as you use the keyboard. Next: open Persona → \"Match how I actually text\" to set the sliders from it.")
                }

                if let stats = me?.stats, stats.examples > 0 {
                    Section {
                        NavigationLink {
                            LearnedMessagesView()
                        } label: {
                            HStack {
                                Text("Messages Rizzio learned from")
                                Spacer()
                                Text("\(stats.examples)").foregroundStyle(.secondary)
                            }
                        }
                    } footer: {
                        Text("Search them, or swipe to remove anything that isn't you.")
                    }
                }

                Section {
                    Button("Forget everything learned", role: .destructive) { confirmReset = true }
                } footer: {
                    Text("Keeps About you, your pasted messages, and your Persona sliders.")
                }
            }
            .themedList()
            .navigationTitle("Train")
            .keyboardDoneButton()
            .safeAreaInset(edge: .bottom) {
                StatusBanner(progress: progress, error: errorMessage, success: successMessage)
            }
            .task { await load() }
            .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                if case let .success(urls) = result { Task { await importFiles(urls) } }
            }
            .sheet(item: $choosing) { pending in
                WhichOneIsYouSheet(filename: pending.filename, preview: pending.preview) { sender in
                    Task { await finishChoice(pending, sender: sender) }
                }
            }
            .refreshable { await load() }
            .onChange(of: uploadItems) { items in
                guard !items.isEmpty else { return }
                Task { await upload(items) }
            }
            .confirmationDialog("Forget everything Rizzio learned?", isPresented: $confirmReset, titleVisibility: .visible) {
                Button("Forget", role: .destructive) { Task { await busy("Forgetting…", done: "Rizzio forgot what it learned.") { try await RizzAPI.resetMemory() } } }
            }
        }
    }

    private func label(for source: String) -> String {
        switch source {
        case "won": return "Got a match or reply"
        case "edited": return "Your rewrite"
        case "imported": return "From your chats"
        case "picked": return "You picked this"
        default: return source
        }
    }

    /// Reloads what Rizzio knows. Doesn't clear an error from the action that just ran,
    /// so a failed save or upload stays visible instead of vanishing on reload.
    @MainActor private func load(keepMessages: Bool = false) async {
        do {
            let me = try await RizzAPI.me()
            self.me = me
            aboutMe = me.aboutMe
            examplesText = me.styleExamples.joined(separator: "\n")
            if !keepMessages { errorMessage = nil }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor private func saveText() async {
        let examples = examplesText.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        await busy("Saving…", done: "Saved \(examples.count) message\(examples.count == 1 ? "" : "s"). Rizzio updated your texting style.") {
            try await RizzAPI.updateMe(aboutMe: aboutMe, styleExamples: examples)
            progress = "Updating your texting style…"
            _ = try await RizzAPI.rebuildProfile()
        }
    }

    @MainActor private func upload(_ items: [PhotosPickerItem]) async {
        var result = (screens: 0, learned: 0)
        await busy("Reading your chats…") {
            result = try await Learner.upload(items, progress: { progress = $0 }) { _, learned in
                uploads.insert(UploadResult(title: "Screenshot", icon: "photo", count: learned.count), at: 0)
            }
        }
        uploadItems = []
        if errorMessage == nil {
            if result.learned == 0 {
                errorMessage = "Couldn't find any of your messages in those screenshots. Use chats where your messages are on the right."
            } else {
                successMessage = "Learned \(result.learned) of your messages from \(result.screens) screenshot\(result.screens == 1 ? "" : "s")."
            }
        }
    }

    // MARK: Importing files

    @MainActor private func importFiles(_ urls: [URL]) async {
        importQueue = []
        importedThisRound = 0
        await busy("Reading your files…") {
            for (i, url) in urls.enumerated() {
                progress = "Reading \(url.lastPathComponent) (\(i + 1) of \(urls.count))…"
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let data = try Data(contentsOf: url)
                guard data.count <= 40 * 1024 * 1024 else {
                    throw RizzError.server("\(url.lastPathComponent) is over 40 MB. Unzip it and pick just the messages files.")
                }
                if UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
                    guard let jpeg = ImageTools.compressedJPEG(from: data) else { continue }
                    let learned = try await RizzAPI.learn(fromScreenshot: jpeg)
                    importedThisRound += learned.count
                    uploads.insert(UploadResult(title: url.lastPathComponent, icon: "photo", count: learned.count), at: 0)
                    continue
                }
                let preview = try await RizzAPI.previewImport(filename: url.lastPathComponent, data: data)
                let pending = PendingImport(filename: url.lastPathComponent, preview: preview)
                if preview.senders.count == 1 {
                    try await commit(pending, sender: preview.senders[0].name)
                } else {
                    importQueue.append(pending) // ask "which one is you?" after reading everything
                }
            }
        }
        if errorMessage == nil { await nextChoiceOrFinish() }
    }

    @MainActor private func commit(_ pending: PendingImport, sender: String) async throws {
        let added = try await RizzAPI.commitImport(importId: pending.preview.importId, sender: sender)
        importedThisRound += added
        uploads.insert(UploadResult(title: pending.filename, icon: "doc.text", count: added), at: 0)
    }

    @MainActor private func finishChoice(_ pending: PendingImport, sender: String?) async {
        choosing = nil
        if let sender {
            await busy("Saving your messages…") { try await commit(pending, sender: sender) }
        }
        if errorMessage == nil { await nextChoiceOrFinish() }
    }

    @MainActor private func nextChoiceOrFinish() async {
        if !importQueue.isEmpty {
            choosing = importQueue.removeFirst()
            return
        }
        guard importedThisRound > 0 else {
            if errorMessage == nil, !uploads.isEmpty { errorMessage = "No new messages from you were found." }
            return
        }
        let count = importedThisRound
        importedThisRound = 0
        await busy("Updating your texting style…", done: "Learned \(count) of your messages.") {
            _ = try await RizzAPI.rebuildProfile()
        }
    }

    @MainActor private func busy(_ message: String, done: String? = nil, _ work: () async throws -> Void) async {
        isBusy = true
        progress = message
        errorMessage = nil
        successMessage = nil
        do {
            try await work()
            successMessage = done
        } catch {
            errorMessage = error.localizedDescription
        }
        isBusy = false
        progress = nil
        await load(keepMessages: true)
    }
}

struct VoiceMatchCard: View {
    let score: Double
    let stats: MeResponse.Stats?

    private var caption: String {
        switch score {
        case ..<15: return "Rizzio barely knows you yet. Upload some chats."
        case ..<50: return "Getting there. A few more chats will sharpen it."
        case ..<85: return "Rizzio has a good read on how you talk."
        default: return "Rizzio texts like you. Keep marking wins in History."
        }
    }

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle().stroke(Theme.hairline, lineWidth: 8)
                Circle()
                    .trim(from: 0, to: score / 100)
                    .stroke(Theme.accent, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(score))%").font(Theme.serif(.headline, weight: .bold))
            }
            .frame(width: 72, height: 72)
            VStack(alignment: .leading, spacing: 4) {
                Text("Style match").font(Theme.serif(.title3, weight: .bold))
                Text(caption).font(.caption).foregroundStyle(.secondary)
                if let stats {
                    Text("\(stats.examples) messages · \(stats.picks) picks · \(stats.wins) wins")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card)
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
