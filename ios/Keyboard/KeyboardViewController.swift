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
        model.clearField = { [weak self] in self?.insertReply("") }
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
    /// Tapping a tone rewrites the current replies in that tone right away.
    @Published var tone: Tone = SharedStore.shared.tone {
        didSet { if tone != oldValue, batch != nil, !isLoading { rewrite(instruction: nil) } }
    }
    /// The length meter: Auto (Persona's Length slider), Phrase, Short, Medium, Long. Picking one rewrites the replies.
    @Published var length: ReplyLength = SharedStore.shared.replyLength {
        didSet {
            SharedStore.shared.replyLength = length
            if length != oldValue, batch != nil, !isLoading { rewrite(instruction: nil) }
        }
    }
    /// The side picked on their take: one of the options Rizzio wrote for it ("Team 11am"), or a generic
    /// for / against / neutral / both when there are none. Nil lets Rizzio decide.
    @Published var side: String? = nil
    @Published var sideChoice: SideChoice? = nil

    /// Picks (or clears) a generic side and rewrites the replies to take it.
    func pickSide(_ value: String) {
        side = side == value ? nil : value
        sideChoice = nil
        rewrite(instruction: nil)
    }

    /// Picks (or clears) one of the options written for this take and rewrites the replies.
    func pickSide(_ choice: SideChoice) {
        sideChoice = sideChoice == choice ? nil : choice
        side = nil
        rewrite(instruction: nil)
    }

    /// The chat panel: quick asks ("Shorter", "Ask them out") and typed requests ("make it about her dog").
    @Published var showChat = false
    /// What you've asked for on these replies so far, oldest first (the conversation with Rizzio), as shown.
    @Published var thread: [String] = []
    /// The same requests as sent to the AI. They all keep applying, so "shorter" then "about the dog" means both.
    private var asks: [String] = []
    @Published var isLoading = false
    @Published var message: String?
    @Published var hasFullAccess = false
    /// The "No emoji" rule, also shown as a one-tap button on the keyboard.
    @Published var noEmoji = SharedStore.shared.persona.isOn("noEmoji")

    var insert: (String) -> Void = { _ in }
    var insertPlain: (String) -> Void = { _ in }
    var clearField: () -> Void = {}
    var deleteBackward: () -> Void = {}
    var nextKeyboard: () -> Void = {}
    var currentDraft: () -> String = { "" }
    var currentFieldText: () -> String = { "" }

    private var lastLoaded: Date?

    func reload() {
        noEmoji = SharedStore.shared.persona.isOn("noEmoji") // you may have changed it in the app
        guard let latest = SharedStore.shared.latestBatch else { return }
        if latest.createdAt != lastLoaded {
            lastLoaded = latest.createdAt
            batch = latest
            rejected = []
            thread = [] // a new screenshot starts a new conversation
            asks = []
            side = latest.stance // a side picked in the Back Tap popup shows as selected
            sideChoice = latest.sideOptions?.first { $0.label == latest.sideLabel }
        }
    }

    /// A reply as it should appear and be sent (emoji removed when No emoji is on).
    func shown(_ reply: Reply) -> String { noEmoji ? reply.text.withoutEmoji : reply.text }

    /// Emoji on/off. Saved to your persona so future replies follow it; turning emoji back on rewrites these replies.
    func toggleEmoji() {
        noEmoji.toggle()
        var persona = SharedStore.shared.persona
        persona.toggles["noEmoji"] = noEmoji
        SharedStore.shared.persona = persona
        guard hasFullAccess else { return }
        let rewrite = !noEmoji && batch?.hasScreenshot == true
        Task { @MainActor in
            try? await RizzAPI.savePersona(persona)
            if rewrite { self.regenerate() }
        }
    }

    /// Inserts a reply and tells the agent you picked it.
    func use(_ reply: Reply, at index: Int) {
        let text = shown(reply)
        insert(text)
        guard let id = batch?.generationId else { return }
        SharedStore.shared.pendingInsert = PendingInsert(generationId: id, replyIndex: index, text: text)
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

    /// 5 fresh replies for the same screenshot or text.
    func regenerate() { rewrite(instruction: nil) }

    /// Quick asks in the chat panel, and what each one tells Rizzio.
    struct QuickAsk: Hashable { let label: String; let instruction: String }
    static let quickAsks: [QuickAsk] = [
        .init(label: "Shorter", instruction: "make them shorter, just a few words"),
        .init(label: "Funnier", instruction: "make them funnier"),
        .init(label: "Bolder", instruction: "make them bolder and more confident"),
        .init(label: "Ask them out", instruction: "suggest meeting up or a date, naturally"),
        .init(label: "Other prompt", instruction: "reply to a different prompt or photo on the profile than last time"),
        .init(label: "Use their photo", instruction: "comment on one of their photos instead of a prompt"),
        .init(label: "More like me", instruction: "sound even more like the user's own texting style"),
    ]

    /// Rewrites the current replies, optionally with a request ("make it about the dog"). Keeps the conversation going.
    func rewrite(instruction: String?, label: String? = nil) {
        guard let batch else {
            message = "Get replies first: Back Tap on a profile or chat, or copy their message and tap Clipboard."
            return
        }
        let previous = batch.replies.map(\.text)
        let mode = batch.mode, tone = self.tone
        let all = asks + [instruction].compactMap { $0 }
        let ask = all.isEmpty ? nil : all.joined(separator: "; and also ")
        let jpeg = batch.hasScreenshot ? SharedStore.shared.loadScreenshot() : nil
        // The screens before this one (same profile): the newest saved screen is the current one.
        let earlier: [Data] = [] // every screenshot is read on its own
        guard jpeg != nil || batch.sourceText != nil || batch.sourceDraft != nil else {
            message = "Take a new screenshot (Back Tap) or use Clipboard."
            return
        }
        run(onSuccess: {
            guard let instruction else { return }
            self.asks.append(instruction)
            self.thread.append(label ?? instruction)
        }) {
            try await RizzAPI.generateAndStore(mode: mode, tone: tone, jpeg: jpeg, text: batch.sourceText,
                                               draft: batch.sourceDraft, instruction: ask, previous: previous, earlier: earlier,
                                               stance: self.side, stanceTopic: batch.sideTopic,
                                               side: self.sideChoice, sideOptions: batch.sideOptions, hook: batch.hook)
        }
    }

    /// Sends what you typed in the text box as a request to Rizzio, then clears the box.
    func askFromField() {
        let typed = currentDraft().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else {
            message = "Type what you want in the text box (like \"make it about her dog\"), then tap Ask."
            return
        }
        clearField()
        rewrite(instruction: String(typed.prefix(300)))
    }

    /// Uses text you copied: a profile prompt or their message. Rizzio works out which it is.
    func fromClipboard() {
        guard let text = UIPasteboard.general.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            message = "Copy their prompt or message first (long-press → Copy)."
            return
        }
        // Auto, not chat: a copied Hinge prompt ("My simple pleasures: ...") should get profile comments,
        // not a reply as if they had texted it. Only the copied text is used, nothing from earlier screenshots.
        run { try await RizzAPI.generateAndStore(mode: .auto, tone: self.tone, text: text) }
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

    private func run(onSuccess: @escaping () -> Void = {}, _ work: @escaping () async throws -> SuggestionBatch) {
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
                onSuccess()
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
            lengthMeter
            if let topic = model.batch?.sideTopic, !topic.isEmpty { sidePicker(topic, options: model.batch?.sideOptions ?? []) }
            if model.showChat { chatPanel }
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
            Button { model.showChat.toggle() } label: {
                Image(systemName: model.showChat ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.and.text.bubble.right")
                    .padding(6)
                    .foregroundColor(model.showChat ? Theme.accent : .primary)
            }
            .accessibilityLabel("Chat with Rizzio")
            Button { model.toggleEmoji() } label: {
                Image(systemName: model.noEmoji ? "face.dashed" : "face.smiling")
                    .padding(6)
                    .foregroundColor(model.noEmoji ? .secondary : Theme.accent)
            }
            .accessibilityLabel(model.noEmoji ? "Emoji off" : "Emoji on")
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
                    // Your requests so far, like a chat with Rizzio.
                    ForEach(Array(model.thread.enumerated()), id: \.offset) { _, ask in
                        Text(ask)
                            .font(.caption)
                            .foregroundColor(.primary)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Theme.card)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    ForEach(Array(batch.replies.enumerated()), id: \.offset) { index, reply in
                        HStack(alignment: .top, spacing: 4) {
                        Button { model.use(reply, at: index) } label: {
                            // Looks like a message you'd send, right-aligned like your own bubbles.
                            VStack(alignment: .trailing, spacing: 3) {
                                Text(model.shown(reply))
                                    .font(.callout)
                                    .foregroundColor(Theme.bubbleMineText)
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, 12).padding(.vertical, 8)
                                    .background(Theme.bubbleMine)
                                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                Text("\(KeyboardRootView.words(in: model.shown(reply))) words · \(reply.angle)")
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

    /// "Pick a side": the options Rizzio wrote for this take ("Team 11am · Team 9am"), or For / Against / Neutral / Both.
    /// Tap the same one again to let Rizzio decide.
    private func sidePicker(_ topic: String, options: [SideChoice]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                if options.isEmpty {
                    sideChip("for", "For \(topic)")
                    sideChip("against", "Against \(topic)")
                    sideChip("neutral", "Neutral")
                    sideChip("both", "Both")
                } else {
                    ForEach(options, id: \.self) { choice in
                        let selected = model.sideChoice == choice
                        Button(choice.label) { model.pickSide(choice) }
                            .font(.caption2.weight(.semibold))
                            .lineLimit(1)
                            .padding(.horizontal, 9).padding(.vertical, 5)
                            .background(selected ? Theme.accent : Theme.card)
                            .foregroundColor(selected ? .white : .primary)
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .disabled(model.isLoading)
    }

    private func sideChip(_ value: String, _ label: String) -> some View {
        let selected = model.side == value
        return Button(label) { model.pickSide(value) }
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(selected ? Theme.accent : Theme.card)
            .foregroundColor(selected ? .white : .primary)
            .clipShape(Capsule())
    }

    static func words(in text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
    }

    private func barColor(filled: Bool, selected: Bool) -> Color {
        if selected { return filled ? Color.white : Color.white.opacity(0.35) }
        return filled ? Theme.accent : Theme.hairline
    }

    /// How long replies should be: a row of segments, each with bars that fill up like a meter.
    private var lengthMeter: some View {
        HStack(spacing: 4) {
            ForEach(ReplyLength.allCases) { option in
                let selected = model.length == option
                Button { model.length = option } label: {
                    HStack(spacing: 4) {
                        if option == .auto {
                            Image(systemName: "slider.horizontal.3").font(.system(size: 9, weight: .bold))
                        } else {
                            HStack(alignment: .bottom, spacing: 1.5) {
                                ForEach(1...4, id: \.self) { bar in
                                    RoundedRectangle(cornerRadius: 1)
                                        .fill(barColor(filled: bar <= option.level, selected: selected))
                                        .frame(width: 3, height: CGFloat(3 + bar * 2))
                                }
                            }
                        }
                        Text(option.label).font(.caption2.weight(.semibold))
                    }
                    .padding(.horizontal, 7).padding(.vertical, 5)
                    .frame(maxWidth: .infinity)
                    .background(selected ? Theme.accent : Theme.card)
                    .foregroundColor(selected ? .white : .primary)
                    .clipShape(Capsule())
                }
                .accessibilityLabel("Length: \(option.label)")
            }
        }
        .disabled(model.isLoading)
    }

    /// Quick asks, plus "Ask" for anything you type in the text box.
    private var chatPanel: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                Button { model.askFromField() } label: {
                    Label("Ask", systemImage: "paperplane.fill")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Theme.accent)
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                }
                .accessibilityLabel("Ask Rizzio what you typed")
                // "Use their photo" makes no sense when the Scan photos switch is off.
                ForEach(KeyboardModel.quickAsks.filter { $0.label != "Use their photo" || !SharedStore.shared.persona.isOn("noPhotos") }, id: \.self) { ask in
                    Button(ask.label) { model.rewrite(instruction: ask.instruction, label: ask.label) }
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .overlay(Capsule().stroke(Theme.accent, lineWidth: 1))
                        .foregroundColor(.primary)
                }
            }
        }
        .disabled(model.isLoading)
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
