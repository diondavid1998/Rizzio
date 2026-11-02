import PhotosUI
import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            TryItView()
                .tabItem { Label("Try it", systemImage: "sparkles") }
            SetupView()
                .tabItem { Label("Setup", systemImage: "list.number") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
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
                        ForEach(batch.replies, id: \.self) { reply in
                            ReplyRow(reply: reply)
                        }
                    } header: {
                        Text(batch.context)
                    } footer: {
                        Text("Tap a reply to copy it. These also appear in the Rizzio keyboard.")
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
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = reply.text
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

// MARK: - Setup guide

struct SetupView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("1. Turn on the keyboard") {
                    Step("Settings → General → Keyboard → Keyboards → Add New Keyboard → Rizzio.")
                    Step("Tap Rizzio in that list and turn on Allow Full Access. The keyboard needs it to reach the internet and see your replies.")
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
                Section("2. Make the Shortcut") {
                    Step("Open the Shortcuts app → + → Add Action → search \"Take Screenshot\" and add it.")
                    Step("Add Action → search \"Get Rizzio Replies\" and add it. Its Screenshot field should say \"Screenshot\" (the result of the step above).")
                    Step("Name it \"Rizzio\". Optional: add \"Get Rizzio Replies\" a second time as a copy with Type set to Chat, for text conversations.")
                }
                Section("3. Put it on a button") {
                    Step("Action Button (iPhone 15 Pro / 16 and newer): Settings → Action Button → swipe to Shortcut → choose Rizzio.")
                    Step("Or Back Tap: Settings → Accessibility → Touch → Back Tap → Double Tap → choose Rizzio. You can set up both.")
                }
                Section("4. Use it") {
                    Step("On a Hinge profile, press the Action Button (or double-tap the back of your phone). In a few seconds you'll see \"5 replies ready\".")
                    Step("Tap the comment box, hold the 🌐 key, pick Rizzio, and tap a reply to insert it. Tap 🌐 again to go back to your normal keyboard.")
                    Step("For texts: copy their message, then tap \"Clipboard\" in the Rizzio keyboard. Or type a draft and tap \"Polish\".")
                }
            }
            .navigationTitle("Setup")
        }
    }
}

private struct Step: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.callout) }
}

// MARK: - Settings

struct SettingsView: View {
    @State private var serverURL = SharedStore.shared.serverURL
    @State private var appToken = SharedStore.shared.appToken
    @State private var aboutMe = SharedStore.shared.aboutMe
    @State private var styleExamples = SharedStore.shared.styleExamples
    @State private var tone = SharedStore.shared.tone
    @State private var saved = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("https://rizzio-backend.yourname.workers.dev", text: $serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("App token", text: $appToken)
                }
                Section {
                    Picker("Default tone", selection: $tone) {
                        ForEach(Tone.allCases) { Text($0.label).tag($0) }
                    }
                }
                Section {
                    TextField("e.g. 27, NYC, nurse, into climbing and cooking, dry humor", text: $aboutMe, axis: .vertical)
                        .lineLimit(2...5)
                } header: {
                    Text("About you")
                } footer: {
                    Text("Helps replies sound like they come from you.")
                }
                Section {
                    TextField("One per line", text: $styleExamples, axis: .vertical)
                        .lineLimit(4...10)
                } header: {
                    Text("Comments that worked for you")
                } footer: {
                    Text("Paste a few messages you've sent that got matches. Rizzio copies your style.")
                }
                Section {
                    Button(saved ? "Saved ✓" : "Save") { save() }
                }
                if !SharedStore.shared.isGroupAvailable {
                    Section {
                        Text("App Group isn't set up, so the keyboard can't see your replies. Check the App Groups setting in Xcode (see README).")
                            .foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }

    private func save() {
        let store = SharedStore.shared
        store.serverURL = serverURL
        store.appToken = appToken
        store.aboutMe = aboutMe
        store.styleExamples = styleExamples
        store.tone = tone
        saved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { saved = false }
    }
}
