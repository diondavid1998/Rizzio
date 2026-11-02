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
        // Picks up new replies from the Back Tap shortcut while the keyboard is open.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.model.reload()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        refreshTimer?.invalidate()
        refreshTimer = nil
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

    private var lastLoaded: Date?

    func reload() {
        guard let latest = SharedStore.shared.latestBatch else { return }
        if latest.createdAt != lastLoaded {
            lastLoaded = latest.createdAt
            batch = latest
        }
    }

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
                            .background(model.tone == tone ? Color.pink : Color(.secondarySystemBackground))
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
                    ForEach(Array(batch.replies.enumerated()), id: \.offset) { _, reply in
                        Button { model.insert(reply.text) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(reply.text)
                                    .font(.callout)
                                    .foregroundColor(.primary)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(reply.angle)
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
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
