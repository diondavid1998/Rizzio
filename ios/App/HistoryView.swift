import SwiftUI

/// Past suggestions. Telling Rizzio how things went is how it learns what works for you.
struct HistoryView: View {
    @State private var items: [HistoryItem] = []
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                }
                if items.isEmpty && errorMessage == nil {
                    Text("Your suggestions will show up here. Mark which ones got a match so Rizzio learns what works.")
                        .foregroundStyle(.secondary)
                }
                ForEach(items) { item in
                    NavigationLink {
                        HistoryDetailView(item: item) { Task { await load() } }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.context).font(.subheadline).lineLimit(2)
                            HStack {
                                if let picked = item.pickedIndex, picked < item.replies.count {
                                    Text(item.replies[picked].text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                } else {
                                    Text("Nothing picked").font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(outcomeBadge(item.outcome))
                            }
                        }
                    }
                }
            }
            .navigationTitle("History")
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func outcomeBadge(_ outcome: String?) -> String {
        switch outcome {
        case "match": return "💘"
        case "replied": return "💬"
        case "ignored": return "🦗"
        default: return ""
        }
    }

    @MainActor private func load() async {
        do {
            items = try await RizzAPI.history()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct HistoryDetailView: View {
    let item: HistoryItem
    var onChange: () -> Void

    @State private var selected: Int?
    @State private var sentText = ""
    @State private var outcome: String?
    @State private var saved = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("Replying to") { Text(item.context) }

            Section {
                ForEach(Array(item.replies.enumerated()), id: \.offset) { index, reply in
                    Button {
                        selected = index
                        sentText = reply.text
                    } label: {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(reply.text).foregroundStyle(.primary)
                                Text(reply.angle).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if selected == index { Image(systemName: "checkmark.circle.fill").foregroundStyle(.pink) }
                        }
                    }
                }
            } header: {
                Text("Which one did you send?")
            }

            if let selected {
                Section {
                    TextField("What you actually sent", text: $sentText, axis: .vertical)
                        .lineLimit(1...5)
                } header: {
                    Text("Did you change it?")
                } footer: {
                    Text("Your edits teach Rizzio how you really text.")
                }

                Section("How did it go?") {
                    Picker("Result", selection: $outcome) {
                        Text("Not yet").tag(String?.none)
                        Text("💘 Match").tag(String?.some("match"))
                        Text("💬 Replied").tag(String?.some("replied"))
                        Text("🦗 Nothing").tag(String?.some("ignored"))
                    }
                    .pickerStyle(.segmented)
                }

                Section {
                    Button(saved ? "Saved ✓" : "Save") { Task { await save(index: selected) } }
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Suggestion")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            selected = item.pickedIndex
            if let i = item.pickedIndex, i < item.replies.count {
                sentText = item.signals.last(where: { $0.kind == "edited" })?.text ?? item.replies[i].text
            }
            outcome = item.outcome
        }
    }

    @MainActor private func save(index: Int) async {
        let reply = item.replies[index].text
        let sent = sentText.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if item.pickedIndex != index {
                try await RizzAPI.feedback(.picked, generationId: item.id, replyIndex: index)
            }
            if !sent.isEmpty, sent != reply {
                try await RizzAPI.feedback(.edited, generationId: item.id, replyIndex: index, text: sent)
            }
            if let outcome, outcome != item.outcome, let kind = FeedbackKind(rawValue: outcome) {
                try await RizzAPI.feedback(kind, generationId: item.id, replyIndex: index, text: sent.isEmpty ? nil : sent)
            }
            saved = true
            errorMessage = nil
            onChange()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
