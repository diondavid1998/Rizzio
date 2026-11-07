import SwiftUI

/// After reading an exported chat: "Which one is you?" Rizzio only learns that person's messages.
struct WhichOneIsYouSheet: View {
    let filename: String
    let preview: ImportPreview
    /// Called with the chosen sender, or nil to skip this file.
    let onDone: (String?) -> Void

    @State private var selected: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(preview.senders) { sender in
                        Button { selected = sender.name } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: selected == sender.name ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(selected == sender.name ? Theme.accent : Theme.muted)
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(sender.name).font(.headline).foregroundStyle(Theme.ink)
                                        Spacer()
                                        Text("\(sender.count) messages").font(.caption).foregroundStyle(Theme.muted)
                                    }
                                    ForEach(sender.samples.prefix(2), id: \.self) { sample in
                                        Text("“\(sample)”").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("sender.\(sender.name)")
                    }
                } header: {
                    Text("Which one is you?")
                } footer: {
                    Text("Found \(preview.total) messages in \(filename). Rizzio will learn only from the person you pick.")
                }
            }
            .themedList()
            .navigationTitle("Import")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Skip") { onDone(nil) } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Import") { onDone(selected) }.disabled(selected == nil)
                }
            }
            .onAppear { selected = preview.guess ?? preview.senders.first?.name }
        }
        .interactiveDismissDisabled()
    }
}

/// Everything Rizzio learned from you, loaded a page at a time so huge imports stay fast.
struct LearnedMessagesView: View {
    @State private var items: [MeResponse.Learned] = []
    @State private var total = 0
    @State private var query = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if let errorMessage {
                Text(errorMessage).foregroundStyle(.red)
            }
            Section {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.text).foregroundStyle(Theme.ink)
                        Text(label(for: item.source)).font(.caption).foregroundStyle(Theme.muted)
                    }
                    .onAppear { if item.id == items.last?.id { Task { await loadMore() } } }
                }
                .onDelete(perform: delete)
                if isLoading { HStack { Spacer(); ProgressView(); Spacer() } }
            } header: {
                Text(query.isEmpty ? "\(total) messages" : "\(total) matching")
            } footer: {
                Text("Swipe left to remove anything that isn't you.")
            }
        }
        .themedList()
        .navigationTitle("Learned messages")
        .searchable(text: $query, prompt: "Search your messages")
        .task(id: query) {
            try? await Task.sleep(nanoseconds: 300_000_000) // wait until you stop typing
            await reload()
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

    @MainActor private func reload() async {
        items = []
        total = 0
        await loadMore()
    }

    @MainActor private func loadMore() async {
        guard !isLoading, items.isEmpty || items.count < total else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await RizzAPI.examples(offset: items.count, query: query)
            items += page.items
            total = page.total
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func delete(_ offsets: IndexSet) {
        let ids = offsets.map { items[$0].id }
        items.remove(atOffsets: offsets)
        total -= ids.count
        Task { for id in ids { try? await RizzAPI.deleteExample(id: id) } }
    }
}
