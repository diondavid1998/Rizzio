import SwiftUI

struct SetupView: View {
    @State private var serverURL = SharedStore.shared.serverURL
    @State private var appToken = SharedStore.shared.appToken
    @State private var tone = SharedStore.shared.tone
    @State private var saved = false
    @AppStorage("appearance") private var appearance = "system"

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://rizzio-backend.up.railway.app", text: $serverURL)
                        .accessibilityIdentifier("serverURL")
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("App token", text: $appToken)
                        .accessibilityIdentifier("appToken")
                    Picker("Default tone", selection: $tone) {
                        ForEach(Tone.allCases) { Text($0.label).tag($0) }
                    }
                    Button(saved ? "Saved ✓" : "Save") { save() }
                } header: {
                    Text("Server")
                }
                Section {
                    Picker("Appearance", selection: $appearance) {
                        Text("Match iPhone").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("appearance")
                } header: {
                    Text("Appearance")
                }
                if !SharedStore.shared.isGroupAvailable {
                    Section {
                        Text("App Group isn't set up, so the keyboard can't see your replies. Check the App Groups capability in Xcode (see README).")
                            .foregroundStyle(.orange)
                    }
                }

                Section("1. Turn on the keyboard") {
                    Step("Settings → General → Keyboard → Keyboards → Add New Keyboard → Rizzio.")
                    Step("Tap Rizzio in that list and turn on Allow Full Access. The keyboard needs it to reach the internet and learn from what you pick.")
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
                Section("2. Make the Shortcut") {
                    Step("Open the Shortcuts app → + → Add Action → search \"Take Screenshot\" and add it.")
                    Step("Add Action → search \"Get Rizzio Replies\" and add it. Its Screenshot field should say \"Screenshot\".")
                    Step("Name it \"Rizzio\". Optional: make a copy with Type set to Chat, for text conversations.")
                }
                Section("3. Put it on a button") {
                    Step("Action Button: Settings → Action Button → swipe to Shortcut → choose Rizzio.")
                    Step("Or Back Tap: Settings → Accessibility → Touch → Back Tap → Double Tap → Rizzio. You can set up both.")
                }
                Section("4. Use it") {
                    Step("On a Hinge profile, press the Action Button. In a few seconds you'll see \"5 replies ready\".")
                    Step("Tap the comment box, hold 🌐, pick Rizzio, and tap a reply. 👎 the ones that aren't you.")
                    Step("For texts: copy their message, then tap Clipboard in the Rizzio keyboard. Or type a draft and tap Polish.")
                    Step("Mark wins in History. The more you use it, the more it sounds like you.")
                }
            }
            .themedList()
            .navigationTitle("Setup")
            .onChange(of: serverURL) { _ in saved = false }
            .onChange(of: appToken) { _ in saved = false }
            .onChange(of: tone) { _ in saved = false }
            .keyboardDoneButton()
        }
    }

    private func save() {
        let store = SharedStore.shared
        store.serverURL = serverURL
        store.appToken = appToken
        store.tone = tone
        saved = true // stays until you change something, so it's clear it worked
    }
}

private struct Step: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.callout) }
}
