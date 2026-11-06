import PhotosUI
import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            TryItView()
                .tabItem { Label("Try it", systemImage: "sparkles") }
            YouView()
                .tabItem { Label("You", systemImage: "person.crop.circle") }
            HistoryView()
                .tabItem { Label("History", systemImage: "clock") }
            SetupView()
                .tabItem { Label("Setup", systemImage: "gearshape") }
        }
    }
}

// MARK: - Try it: pick a screenshot or paste text, see replies

struct TryItView: View {
    @State private var photoItem: PhotosPickerItem?
    @State private var pastedText = ""
    @State private var mode: RizzMode = .prompt
    @State private var tone: Tone = SharedStore.shared.tone
    @State private var batch: SuggestionBatch? = SharedStore.shared.latestBatch
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Replying to", selection: $mode) {
                        Text("Profile").tag(RizzMode.prompt)
                        Text("Chat").tag(RizzMode.chat)
                    }
                    .pickerStyle(.segmented)
                    Picker("Tone", selection: $tone) {
                        ForEach(Tone.allCases) { Text($0.label).tag($0) }
                    }
                }
                Section("From a screenshot") {
                    PhotosPicker(selection: $photoItem, matching: .screenshots) {
                        Label("Choose screenshot", systemImage: "photo")
                    }
                }
                Section("Or paste text") {
                    TextField("Their prompt or message", text: $pastedText, axis: .vertical)
                        .lineLimit(2...6)
                    Button("Get replies") { Task { await run(text: pastedText) } }
                        .disabled(pastedText.trimmingCharacters(in: .whitespaces).isEmpty || isLoading)
                }
                if isLoading {
                    Section { HStack { ProgressView(); Text("Writing replies…") } }
                }
                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }
                if let batch {
                    Section {
                        ForEach(Array(batch.replies.enumerated()), id: \.offset) { index, reply in
                            ReplyRow(reply: reply) {
                                RizzAPI.feedbackInBackground(.picked, generationId: batch.generationId, replyIndex: index)
                            }
                        }
                    } header: {
                        Text(batch.context)
                    } footer: {
                        Text("Tap to copy. Rizzio learns from what you pick. These also show in the Rizzio keyboard.")
                    }
                }
            }
            .navigationTitle("Rizzio")
            .onChange(of: photoItem) { item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let jpeg = ImageTools.compressedJPEG(from: data) {
                        await run(jpeg: jpeg)
                    } else {
                        errorMessage = "Couldn't load that image."
                    }
                    photoItem = nil
                }
            }
            .onAppear { batch = SharedStore.shared.latestBatch }
        }
    }

    @MainActor
    private func run(jpeg: Data? = nil, text: String? = nil) async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            batch = try await RizzAPI.generateAndStore(mode: mode, tone: tone, jpeg: jpeg, text: text, keepScreenshot: true)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ReplyRow: View {
    let reply: Reply
    var onCopy: () -> Void = {}
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = reply.text
            onCopy()
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(reply.text).foregroundStyle(.primary)
                Text(copied ? "Copied" : reply.angle)
                    .font(.caption)
                    .foregroundStyle(copied ? Color.green : Color.secondary)
            }
            .padding(.vertical, 2)
        }
    }
}
