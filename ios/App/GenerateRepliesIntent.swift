import AppIntents
import SwiftUI
import UIKit
import Foundation

/// Shows up in the Shortcuts app as "Get Rizzio Replies".
/// Shortcut: Take Screenshot → Get Rizzio Replies. Assign it to Back Tap.
/// Runs in the background, so you never leave Hinge.
struct GenerateRepliesIntent: AppIntent {
    static var title: LocalizedStringResource = "Get Rizzio Replies"
    static var description = IntentDescription("Reads a screenshot (a dating profile or a chat) and writes 5 replies. Open the Rizzio keyboard to use them.")
    static var openAppWhenRun: Bool = false

    /// Connects to the previous action's output (Take Screenshot) automatically, so nobody has to pick a file.
    /// Optional: if it's empty, the screenshot is taken from the clipboard (Take Screenshot → Copy to Clipboard → this).
    @Parameter(title: "Screenshot", supportedTypeIdentifiers: ["public.image"], inputConnectionBehavior: .connectToPreviousIntentResult)
    var screenshot: IntentFile?

    static var parameterSummary: some ParameterSummary {
        Summary("Get Rizzio replies for \(\.$screenshot)") {
            \.$kind
            \.$tone
            \.$side
            \.$pickHere
        }
    }

    @Parameter(title: "Type", default: .auto)
    var kind: ScreenKind

    @Parameter(title: "Tone (optional)")
    var tone: ToneOption?

    /// Which side of their take to reply from ("11am church over 9am"): ask each time, or always use one.
    /// Asked only when Scan photos is off (replies are about their prompts, not photos).
    @Parameter(title: "Pick a side", default: .ask)
    var side: SideOption

    /// Holds the side picked from the options Rizzio offers for this prompt ("Team 11am"). Filled when it asks.
    @Parameter(title: "Picked side", default: "")
    var pickedSide: String

    /// When several prompts or photos are on screen: ask which one to reply to, or let Rizzio pick.
    @Parameter(title: "Pick what to reply to", default: true)
    var askWhichPrompt: Bool

    /// Rizzio shows the replies, you tap one, it's copied and noted as your pick (no Choose from List needed).
    @Parameter(title: "Pick and copy here", default: true)
    var pickHere: Bool

    /// Holds the reply you tapped.
    @Parameter(title: "Picked reply", default: "")
    var pickedReply: String

    /// Holds what you type after picking "Type my own…": how Rizzio should tackle the reply.
    @Parameter(title: "Your own take", default: "")
    var myTake: String

    /// Holds the prompt or photo picked when it asks.
    @Parameter(title: "Picked prompt", default: "")
    var pickedHook: String

    /// Returns the 5 replies as a list, so the shortcut can show them with "Choose from List" and copy the one you tap.
    func perform() async throws -> some IntentResult & ReturnsValue<[String]> & ProvidesDialog & ShowsSnippetView {
        // The connected Screenshot, or else an image on the clipboard (when the shortcut copies it there).
        let raw = screenshot?.data ?? UIPasteboard.general.image?.pngData()
        guard let raw, let jpeg = ImageTools.compressedJPEG(from: raw) else {
            throw RizzError.server("No screenshot reached Rizzio. In your shortcut, add Copy to Clipboard between Take Screenshot and Get Rizzio Replies.")
        }
        let mode: RizzMode
        switch kind {
        case .auto: mode = .auto
        case .profile: mode = .prompt
        case .chat: mode = .chat
        }
        // Screenshots from the last few minutes are usually the same profile, scrolled: send them too.
        let store = SharedStore.shared
        // Every screenshot is read on its own: nothing from earlier Back Taps is mixed in.
        let earlier: [Data] = []
        let pickedTone = tone.flatMap { Tone(rawValue: $0.rawValue) }
        // A quick on-phone read (no AI): bubbles on both sides means a chat. Profiles get lighter, faster thinking.
        let looksLike: String? = mode == .auto ? ((try? OnDeviceAI.read(jpeg)).map { lines in
            lines.contains { $0.side == .me } && lines.contains { $0.side == .them } ? "chat" : "profile"
        }) : nil
        // Back Tapped the same screen again within 3 minutes: the last replies (or their angle) didn't work.
        // Don't repeat them; if none was picked, say so (a mild "not these" for the ranking) and change the angle.
        let fingerprint = ImageTools.fingerprint(jpeg)
        var avoid: [String] = []
        var redoNote: String? = nil
        if let fp = fingerprint, let last = store.lastBackTap, Date().timeIntervalSince(last.date) < 180,
           ImageTools.distance(fp, last.fingerprint) <= 3 {
            avoid = last.replies
            if !last.picked {
                redoNote = "The user Back Tapped this same screen again without picking any of the earlier replies: they didn't like those or their angle. Take clearly different angles and forms this time."
                if let id = last.generationId { RizzAPI.feedbackInBackground(.redo, generationId: id) }
            }
        }
        var batch = try await RizzAPI.generateAndStore(
            mode: mode, tone: pickedTone, jpeg: jpeg, keepScreenshot: true, instruction: redoNote, previous: avoid, earlier: earlier, looksLike: looksLike
        )
        store.clearProfileScreens() // drop anything older builds kept

        // Several prompts or photos on screen: ask which one to reply to.
        var chosenHook: String? = nil
        let hooks = (batch.visibleHooks ?? []).filter { !$0.isEmpty }
        if askWhichPrompt, hooks.count >= 2 {
            let letRizzio = "Let Rizzio pick"
            let picked = try await $pickedHook.requestDisambiguation(
                among: hooks + [letRizzio],
                dialog: IntentDialog(stringLiteral: "Which one should I reply to?")
            )
            if picked != letRizzio {
                chosenHook = picked
                batch = try await RizzAPI.generateAndStore(
                    mode: mode, tone: pickedTone, jpeg: jpeg, keepScreenshot: true, previous: avoid, earlier: earlier, hook: picked, looksLike: looksLike
                )
            }
        }

        // Ask how to reply after every screenshot: which side of their take (options written for this prompt),
        // which one's the lie (Two truths and a lie), or ways to reply. Then write the replies from that.
        let isLieGame = batch.sideTopic == "which is the lie"
        // Asked after every screenshot (photos on or off): a side when there's a take, otherwise ways to reply.
        let howToReply = batch.sideTopic == "how to reply"
        if let topic = batch.sideTopic, !topic.isEmpty, side != .decide {
            let options = batch.sideOptions ?? []
            if side == .ask, !options.isEmpty {
                let decide = isLieGame ? "Let Rizzio guess" : "Let Rizzio decide"
                let typeOwn = "Type my own…"
                // Instant answers: the first set's candidates already covered every option, so the server kept
                // the best replies for each one. Tapping an option switches to those with no new AI request.
                let firstBatch = batch
                let picked = try await $pickedSide.requestDisambiguation(
                    among: options.map(\.label) + [typeOwn, decide],
                    dialog: IntentDialog(stringLiteral: isLieGame ? "Which one's the lie?" : howToReply ? "How should I reply?" : "\(topic.prefix(1).uppercased() + topic.dropFirst()): which side?")
                )
                if picked == typeOwn {
                    // A text box: say in your own words how to tackle it ("agree but tease her about the 9am").
                    let typed = try await $myTake.requestValue(IntentDialog(stringLiteral: "How should Rizzio reply? Say it your way"))
                    let take = typed.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !take.isEmpty {
                        batch = try await RizzAPI.generateAndStore(
                            mode: mode, tone: pickedTone, jpeg: jpeg, keepScreenshot: true,
                            instruction: "Reply the way the user wants to tackle it: \(take.prefix(250)). All 5 messages follow this.",
                            previous: avoid, earlier: earlier, stanceTopic: topic, sideOptions: options, hook: chosenHook, looksLike: looksLike
                        )
                    }
                } else if let choice = options.first(where: { $0.label == picked }) {
                    if let ready = firstBatch.bySide?[choice.label], ready.replies.count >= 3 {
                        let instant = SuggestionBatch(
                            generationId: ready.generationId, context: firstBatch.context, replies: ready.replies, mode: firstBatch.mode,
                            createdAt: Date(), hasScreenshot: firstBatch.hasScreenshot, sourceText: firstBatch.sourceText,
                            sourceDraft: firstBatch.sourceDraft, sideTopic: topic, stance: nil, sideOptions: options,
                            sideLabel: choice.label, visibleHooks: firstBatch.visibleHooks, hook: chosenHook
                        )
                        batch = instant
                        RizzAPI.use(instant, jpeg: jpeg, keepScreenshot: true)
                        RizzAPI.recordChoiceInBackground(choice.label)
                    } else {
                        batch = try await RizzAPI.generateAndStore(
                            mode: mode, tone: pickedTone, jpeg: jpeg, keepScreenshot: true, previous: avoid, earlier: earlier,
                            stanceTopic: topic, side: choice, sideOptions: options, hook: chosenHook, looksLike: looksLike
                        )
                    }
                } else {
                    batch = firstBatch // Let Rizzio decide: the best 5 across every option
                }
            } else if let stance = side.stance {
                batch = try await RizzAPI.generateAndStore(
                    mode: mode, tone: pickedTone, jpeg: jpeg, keepScreenshot: true, previous: avoid, earlier: earlier,
                    stance: stance, stanceTopic: topic, sideOptions: options, hook: chosenHook, looksLike: looksLike
                )
            }
        }
        guard !batch.replies.isEmpty else { throw RizzError.server("No replies this time. Try another screenshot.") }
        let replies = batch.replies.map(\.text)
        store.lastBackTap = LastBackTap(date: Date(), fingerprint: fingerprint ?? [], generationId: batch.generationId, replies: replies, picked: false)
        let winNote = (batch.wins ?? 0) > 0 ? "Nice, one of your Rizzio lines got a reply. Rizzio learned from it.\n" : ""
        if pickHere, let chosen = try await PickAndCopy.run(replies: replies, batch: batch, param: $pickedReply) {
            return .result(value: [chosen], dialog: IntentDialog(stringLiteral: winNote + "Copied. Paste it in Hinge."), view: RepliesSnippet(replies: [chosen]))
        }
        // A card with the 5 replies numbered 1-5, one per line (plain dialogs merge lines into a paragraph),
        // then the shortcut's Choose from List lets you pick one to copy.
        let spoken = replies.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        return .result(value: replies, dialog: IntentDialog(full: LocalizedStringResource(stringLiteral: spoken), supporting: "Your replies"), view: RepliesSnippet(replies: replies))
    }
}


/// Shows up in Shortcuts as "Get Rizzio Replies (Several Screenshots)".
/// For one profile across 2-4 screenshots, so Rizzio knows the whole person (hinge-auto reads whole profiles).
/// Shortcut: Select Photos (Select Multiple on) → this. The last photo is the one to reply to.
/// Only the screenshots you pick together are sent, so nobody else's profile gets mixed in.
struct GenerateFromScreenshotsIntent: AppIntent {
    static var title: LocalizedStringResource = "Get Rizzio Replies (Several Screenshots)"
    static var description = IntentDescription("Reads 2-4 screenshots of the same profile together (the last one is what you reply to) and writes replies. Open the Rizzio keyboard to use them.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Screenshots", supportedTypeIdentifiers: ["public.image"], inputConnectionBehavior: .connectToPreviousIntentResult)
    var screenshots: [IntentFile]

    @Parameter(title: "Tone (optional)")
    var tone: ToneOption?

    @Parameter(title: "Pick and copy here", default: true)
    var pickHere: Bool

    @Parameter(title: "Picked reply", default: "")
    var pickedReply: String

    static var parameterSummary: some ParameterSummary {
        Summary("Get Rizzio replies for \(\.$screenshots)") {
            \.$tone
            \.$pickHere
        }
    }

    func perform() async throws -> some IntentResult & ReturnsValue<[String]> & ProvidesDialog & ShowsSnippetView {
        let images = screenshots.suffix(4).compactMap { ImageTools.compressedJPEG(from: $0.data) }
        guard let current = images.last else {
            throw RizzError.server("No screenshots reached Rizzio. In your shortcut, use Select Photos with Select Multiple on, then this action.")
        }
        let batch = try await RizzAPI.generateAndStore(
            mode: .prompt, tone: tone.flatMap { Tone(rawValue: $0.rawValue) }, jpeg: current, keepScreenshot: true, earlier: Array(images.dropLast())
        )
        guard !batch.replies.isEmpty else { throw RizzError.server("No replies this time. Try other screenshots.") }
        let replies = batch.replies.map(\.text)
        if pickHere, let chosen = try await PickAndCopy.run(replies: replies, batch: batch, param: $pickedReply) {
            return .result(value: [chosen], dialog: IntentDialog(stringLiteral: "Copied. Paste it in Hinge."), view: RepliesSnippet(replies: [chosen]))
        }
        let spoken = replies.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        return .result(value: replies, dialog: IntentDialog(full: LocalizedStringResource(stringLiteral: spoken), supporting: "Your replies"), view: RepliesSnippet(replies: replies))
    }
}

/// Shows the replies to tap, copies the one you pick and tells Rizzio it was your pick (trains the ranking).
/// iOS asks "Allow Paste?" whenever an app reads what another app copied, so Rizzio does the picking itself
/// instead of checking the clipboard afterwards.
enum PickAndCopy {
    static func run(replies: [String], batch: SuggestionBatch, param: IntentParameter<String>) async throws -> String? {
        let numbered = replies.enumerated().map { "\($0.offset + 1). \($0.element)" }
        let picked = try await param.requestDisambiguation(among: numbered, dialog: IntentDialog(stringLiteral: "Which one? It'll be copied"))
        guard let index = numbered.firstIndex(of: picked) else { return nil }
        let chosen = replies[index]
        await MainActor.run { UIPasteboard.general.string = chosen }
        SharedStore.shared.lastBackTap?.picked = true
        if let id = batch.generationId {
            try? await RizzAPI.feedback(.picked, generationId: id, replyIndex: index)
            // So the keyboard can notice later if you changed it before sending.
            SharedStore.shared.pendingInsert = PendingInsert(generationId: id, replyIndex: index, text: chosen)
        }
        return chosen
    }
}

/// Shows up in Shortcuts as "Tell Rizzio Which One I Picked".
/// Put it after Choose from List (Back Tap shortcut), so Rizzio learns which reply you went with,
/// the same as tapping one in the keyboard. Runs silently in the background.
struct RecordPickIntent: AppIntent {
    static var title: LocalizedStringResource = "Tell Rizzio Which One I Picked"
    static var description = IntentDescription("Put this after Choose from List. Rizzio learns which reply you picked, so it ranks that kind of reply higher next time.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Picked reply", inputConnectionBehavior: .connectToPreviousIntentResult)
    var picked: String

    static var parameterSummary: some ParameterSummary {
        Summary("Tell Rizzio I picked \(\.$picked)")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let store = SharedStore.shared
        let text = picked.trimmingCharacters(in: .whitespacesAndNewlines)
        if let batch = store.latestBatch, let id = batch.generationId,
           let index = batch.replies.firstIndex(where: { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == text })
                ?? batch.replies.firstIndex(where: { $0.text.hasPrefix(text.prefix(40)) }) {
            try? await RizzAPI.feedback(.picked, generationId: id, replyIndex: index)
            // So the keyboard can notice later if you changed it before sending.
            store.pendingInsert = PendingInsert(generationId: id, replyIndex: index, text: batch.replies[index].text)
        }
        // Passes the text through, so Copy to Clipboard can come after this too.
        return .result(value: picked)
    }
}

enum ScreenKind: String, AppEnum {
    case auto, profile, chat
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Screen type"
    static var caseDisplayRepresentations: [ScreenKind: DisplayRepresentation] = [
        .auto: "Auto-detect",
        .profile: "Dating profile",
        .chat: "Chat conversation",
    ]
}

enum ToneOption: String, AppEnum {
    case witty, humor, question, flirty, chill, bold, sweet, corny
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Tone"
    static var caseDisplayRepresentations: [ToneOption: DisplayRepresentation] = [
        .witty: "Witty", .humor: "Humor", .question: "Question", .flirty: "Flirty", .chill: "Chill", .bold: "Bold", .sweet: "Sweet", .corny: "Corny",
    ]
}

/// The card shown after Back Tap: replies numbered 1-5, each on its own line.
struct RepliesSnippet: View {
    let replies: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(replies.enumerated()), id: \.offset) { index, text in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(index + 1).").font(.callout.weight(.bold)).monospacedDigit()
                    Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }
}

/// Which side to take when a prompt invites one. "Ask" pops up a choice each time.
enum SideOption: String, AppEnum {
    case ask, forIt, against, neutral, both, decide
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Side"
    static var caseDisplayRepresentations: [SideOption: DisplayRepresentation] = [
        .ask: "Ask each time", .forIt: "For", .against: "Against", .neutral: "Neutral", .both: "Both", .decide: "Let Rizzio decide",
    ]
    /// The value the server expects, or nil to let Rizzio decide.
    var stance: String? {
        switch self {
        case .forIt: return "for"
        case .against: return "against"
        case .neutral: return "neutral"
        case .both: return "both"
        case .ask, .decide: return nil
        }
    }
}
