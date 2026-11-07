import SwiftUI

@main
struct RizzioApp: App {
    /// "system", "light" or "dark", chosen in Setup.
    @AppStorage("appearance") private var appearance = "system"

    init() {
        // Standard iOS navigation titles: custom bar styling hid the large titles.
        // Automated UI tests point the app at a local test server with a fixed user.
        let env = ProcessInfo.processInfo.environment
        if let server = env["RIZZIO_UITEST_SERVER"], let token = env["RIZZIO_UITEST_TOKEN"] {
            let store = SharedStore.shared
            store.serverURL = server
            store.appToken = token
            store.persona = .default
            store.latestBatch = nil
            store.engine = .premium
            UserDefaults.standard.set(env["RIZZIO_UITEST_APPEARANCE"] ?? "light", forKey: "appearance")
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .tint(Theme.accent)
                .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        }
    }
}
