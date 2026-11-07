import SwiftUI

struct ContentView: View {
    private enum Tab { case persona, train, history, setup }
    // First launch (no server yet): open on Setup instead of a screen full of connection errors.
    @State private var tab: Tab = SharedStore.shared.isConfigured ? .persona : .setup

    var body: some View {
        TabView(selection: $tab) {
            PersonaView()
                .tabItem { Label("Persona", systemImage: "slider.horizontal.3") }
                .tag(Tab.persona)
            TrainView()
                .tabItem { Label("Train", systemImage: "square.and.arrow.up") }
                .tag(Tab.train)
            HistoryView()
                .tabItem { Label("History", systemImage: "clock") }
                .tag(Tab.history)
            SetupView()
                .tabItem { Label("Setup", systemImage: "gearshape") }
                .tag(Tab.setup)
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
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(reply.text).foregroundStyle(Theme.ink)
                Text(copied ? "Copied" : reply.angle)
                    .font(.caption)
                    .foregroundStyle(copied ? Color.green : Color.secondary)
            }
            .padding(.vertical, 2)
        }
    }
}
