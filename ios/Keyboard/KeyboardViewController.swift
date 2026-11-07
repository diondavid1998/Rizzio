import SwiftUI
import UIKit

/// The Rizzio keyboard: shows the latest 5 replies and inserts the one you tap.
final class KeyboardViewController: UIInputViewController {
    private let model = KeyboardModel()
    private var hosting: UIHostingController<KeyboardRootView>?
    private var refreshTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()

        model.insert = { [weak self] text in self?.insertReply(text) }
        model.currentFieldText = { [weak self] in self?.currentText() ?? "" }
        model.deleteBackward = { [weak self] in self?.textDocumentProxy.deleteBackward() }
        model.insertPlain = { [weak self] text in self?.textDocumentProxy.insertText(text) }
        model.nextKeyboard = { [weak self] in self?.advanceToNextInputMode() }
        model.currentDraft = { [weak self] in self?.currentText() ?? "" }
        model.hasFullAccess = hasFullAccess

        let root = KeyboardRootView(model: model)
        let hosting = UIHostingController(rootView: root)
        hosting.view.backgroundColor = .clear
        addChild(hosting)
        view.addSubview(hosting.view)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        let height = view.heightAnchor.constraint(equalToConstant: 300)
        height.priority = UILayoutPriority(999)
        height.isActive = true
        hosting.didMove(toParent: self)
        self.hosting = hosting
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        model.hasFullAccess = hasFullAccess
        model.reload()
        model.checkForEdit(immediate: true) // you may have edited the reply with another keyboard
        // Picks up new replies from the Back Tap shortcut while the keyboard is open.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.model.reload()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        refreshTimer?.invalidate()
        refreshTimer = nil
        model.checkForEdit(immediate: true)
    }

    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        model.checkForEdit()
    }

    private func currentText() -> String {
        (textDocumentProxy.documentContextBeforeInput ?? "") + (textDocumentProxy.documentContextAfterInput ?? "")
    }

    /// Replaces whatever is in the text box (as far as the keyboard can see it) with the reply.
    private func insertReply(_ text: String) {
        let proxy = textDocumentProxy
        if let after = proxy.documentContextAfterInput, !after.isEmpty {
            proxy.adjustTextPosition(byCharacterOffset: after.count)
        }
        if let before = proxy.documentContextBeforeInput {
            for _ in 0..<before.count { proxy.deleteBackward() }
        }
        proxy.insertText(text)
    }
}

// MARK: - State

final class KeyboardModel: ObservableObject {
    @Published var batch: SuggestionBatch?
    @Published var tone: Tone = SharedStore.shared.tone
    @Published var isLoading = false
    @Published var message: String?
    @Published var hasFullAccess = false

    var insert: (String) -> Void = { _ in }
    var insertPlain: (String) -> Void = { _ in }
    var deleteBackward: () -> Void = {}
    var nextKeyboard: () -> Void = {}
    var currentDraft: () -> String = { "" }
    var currentFieldText: () -> String = { "" }

    private var lastLoaded: Date?

    func reload() {
        guard let latest = SharedStore.shared.latestBatch else { return }
        if latest.createdAt != lastLoaded {
            lastLoaded = latest.createdAt
            batch = latest
            rejected = []
        }
    }

    /// Inserts a reply and tells the agent you picked it.
    func use(_ reply: Reply, at index: Int) {
        insert(reply.text)
        guard let id = batch?.generationId else { return }
        SharedStore.shared.pendingInsert = PendingInsert(generationId: id, replyIndex: index, text: reply.text)
        if hasFullAccess { RizzAPI.feedbackInBackground(.picked, generationId: id, replyIndex: index) }
    }

    /// "Not me": the agent learns to avoid this kind of reply.
    func reject(at index: Int) {
        guard let id = batch?.generationId, hasFullAccess else { return }
        rejected.insert(index)
        RizzAPI.feedbackInBackground(.rejected, generationId: id, replyIndex: index)
    }

    @Published var rejected: Set<Int> = []

    /// If you changed an inserted reply before sending, your version is the best example of your voice.
    func checkForEdit(immediate: Bool = false) {
        guard hasFullAccess, let pending = SharedStore.shared.pendingInsert else { return }
        let current = currentFieldText().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !current.isEmpty, current != pending.text, current.count >= 3 else { return }
        // Only count it if it still looks like a version of the reply (not a new message).
        let overlap = Set(current.lowercased().split(separator: " ")).intersection(Set(pending.text.lowercased().split(separator: " "))).count
        guard overlap >= 2 else { return }
        editDebounce?.invalidate()
        let report = {
            RizzAPI.feedbackInBackground(.edited, generationId: pending.generationId, replyIndex: pending.replyIndex, text: current)
            SharedStore.shared.pendingInsert = nil
        }
        if immediate {
            report()
        } else {
            // Wait until you stop typing, so we learn from the finished version.
            editDebounce = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: false) { _ in report() }
        }
    }

    private var editDebounce: Timer?

    /// Same screenshot, new tone.
    func regenerate() {
        guard let batch else { return }
        if batch.hasScreenshot, let jpeg = SharedStore.shared.loadScreenshot() {
            run { try await RizzAPI.generateAndStore(mode: batch.mode, tone: self.tone, jpeg: jpeg) }
        } else {
            message = "Take a new screenshot (Back Tap) or use Clipboard."
        }
    }

    /// Uses text you copied (e.g. their message) as the conversation.
    func fromClipboard() {
        guard let text = UIPasteboard.general.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            message = "Copy their message first (long-press → Copy)."
            return
        }
        run { try await RizzAPI.generateAndStore(mode: .chat, tone: self.tone, text: text) }
    }

    /// Rewrites what you've typed so far.
    func polishDraft() {
        let draft = currentDraft()
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            message = "Type a draft first, then tap Polish."
            return
        }
        let context = batch.map { "Earlier context: \($0.context)" }
        run { try await RizzAPI.generateAndStore(mode: .draft, tone: self.tone, text: context, draft: draft) }
    }

    private func run(_ work: @escaping () async throws -> SuggestionBatch) {
        guard hasFullAccess else {
            message = "Turn on Allow Full Access for Rizzio in Settings."
            return
        }
        isLoading = true
        message = nil
        Task { @MainActor in
            do {
                let newBatch = try await work()
                self.lastLoaded = newBatch.createdAt
                self.batch = newBatch
                self.rejected = []
            } catch {
                self.message = error.localizedDescription
            }
            self.isLoading = false
        }
    }
}

// MARK: - UI

struct KeyboardRootView: View {
    @ObservedObject var model: KeyboardModel

    var body: some View {
        VStack(spacing: 6) {
            toolbar
            content
            bottomRow
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 6)
    }

    private var toolbar: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Tone.allCases) { tone in
                        Button(tone.label) { model.tone = tone }
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(model.tone == tone ? Theme.accent : Theme.card)
                            .foregroundColor(model.tone == tone ? .white : .primary)
                            .clipShape(Capsule())
                    }
                }
            }
            Button { model.regenerate() } label: {
                Image(systemName: "arrow.clockwise")
                    .padding(6)
            }
            .disabled(model.isLoading || model.batch == nil)
        }
    }

    @ViewBuilder
    private var content: some View {
        if !model.hasFullAccess {
            notice("Turn on Full Access: Settings → General → Keyboard → Keyboards → Rizzio → Allow Full Access.")
        } else if model.isLoading {
            VStack(spacing: 8) {
                ProgressView()
                Text("Writing replies…").font(.caption).foregroundColor(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let batch = model.batch {
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    if let message = model.message {
                        Text(message).font(.caption).foregroundColor(.orange)
                    }
                    Text(batch.context)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                    ForEach(Array(batch.replies.enumerated()), id: \.offset) { index, reply in
                        HStack(alignment: .top, spacing: 4) {
                        Button { model.use(reply, at: index) } label: {
                            // Looks like a message you'd send, right-aligned like your own bubbles.
                            VStack(alignment: .trailing, spacing: 3) {
                                Text(reply.text)
                                    .font(.callout)
                                    .foregroundColor(Theme.bubbleMineText)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(Theme.bubbleMine)
                                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                Text(reply.angle)
                                    .font(.caption2)
                                    .foregroundColor(Theme.muted)
                                    .padding(.trailing, 6)
                            }
                            .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        Button { model.reject(at: index) } label: {
                            Image(systemName: model.rejected.contains(index) ? "hand.thumbsdown.fill" : "hand.thumbsdown")
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .padding(8)
                        }
                        .accessibilityLabel("Not me")
                        }
                        .opacity(model.rejected.contains(index) ? 0.4 : 1)
                    }
                }
            }
        } else {
            notice(model.message ?? "Double-tap the back of your phone on a profile, or copy a message and tap Clipboard.")
        }
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundColor(.secondary)
            .multilineTextAlignment(.center)
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var bottomRow: some View {
        HStack(spacing: 6) {
            key(systemImage: "globe") { model.nextKeyboard() }
            key(title: "Clipboard") { model.fromClipboard() }
            key(title: "Polish") { model.polishDraft() }
            key(title: "space", wide: true) { model.insertPlain(" ") }
            key(systemImage: "delete.left") { model.deleteBackward() }
            key(systemImage: "return") { model.insertPlain("\n") }
        }
        .frame(height: 40)
    }

    private func key(title: String? = nil, systemImage: String? = nil, wide: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Group {
                if let systemImage { Image(systemName: systemImage) } else { Text(title ?? "").font(.footnote) }
            }
            .frame(maxWidth: wide ? .infinity : nil, maxHeight: .infinity)
            .padding(.horizontal, 10)
            .background(Color(.systemBackground))
            .foregroundColor(.primary)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .shadow(color: .black.opacity(0.15), radius: 0, x: 0, y: 1)
        }
        .disabled(model.isLoading && title != "space" && systemImage != "delete.left" && systemImage != "globe" && systemImage != "return")
    }
}
