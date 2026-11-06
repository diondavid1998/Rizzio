import SwiftUI

struct ContentView: View {
    var body: some View {
        TabView {
            PersonaView()
                .tabItem { Label("Persona", systemImage: "slider.horizontal.3") }
            TrainView()
                .tabItem { Label("Train", systemImage: "square.and.arrow.up") }
            HistoryView()
                .tabItem { Label("History", systemImage: "clock") }
            SetupView()
                .tabItem { Label("Setup", systemImage: "gearshape") }
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
