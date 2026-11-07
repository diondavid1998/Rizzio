import SwiftUI

@main
struct RizzioApp: App {
    init() {
        // Automated UI tests point the app at a local test server with a fixed user.
        let env = ProcessInfo.processInfo.environment
        if let server = env["RIZZIO_UITEST_SERVER"], let token = env["RIZZIO_UITEST_TOKEN"] {
            let store = SharedStore.shared
            store.serverURL = server
            store.appToken = token
            store.persona = .default
            store.latestBatch = nil
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .tint(.pink)
        }
    }
}
