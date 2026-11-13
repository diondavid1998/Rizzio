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
        }
    }

    @Parameter(title: "Type", default: .auto)
    var kind: ScreenKind

    @Parameter(title: "Tone (optional)")
    var tone: ToneOption?

    /// When a prompt invites taking a side ("pineapple on pizza"): ask each time, or always use one.
    @Parameter(title: "Side on hot takes", default: .ask)
    var side: SideOption

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
        let earlier = mode == .chat ? [] : store.profileScreens()
        let pickedTone = tone.flatMap { Tone(rawValue: $0.rawValue) }
        var batch = try await RizzAPI.generateAndStore(
            mode: mode, tone: pickedTone, jpeg: jpeg, keepScreenshot: true, earlier: earlier
        )
        store.addProfileScreen(jpeg)

        // The prompt invites a side: ask which one (or use the shortcut's setting), then write replies that take it.
        if let topic = batch.sideTopic, !topic.isEmpty, side != .decide {
            var choice = side
            if choice == .ask {
                choice = try await $side.requestDisambiguation(
                    among: [.forIt, .against, .neutral, .both, .decide],
                    dialog: IntentDialog(stringLiteral: "\(topic.prefix(1).uppercased() + topic.dropFirst()): which side?")
                )
            }
            if let stance = choice.stance {
                batch = try await RizzAPI.generateAndStore(
                    mode: mode, tone: pickedTone, jpeg: jpeg, keepScreenshot: true, earlier: earlier,
                    stance: stance, stanceTopic: topic
                )
            }
        }
        guard !batch.replies.isEmpty else { throw RizzError.server("No replies this time. Try another screenshot.") }
        let replies = batch.replies.map(\.text)
        // A card with the 5 replies numbered 1-5, one per line (plain dialogs merge lines into a paragraph),
        // then the shortcut's Choose from List lets you pick one to copy.
        let spoken = replies.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
        return .result(value: replies, dialog: IntentDialog(full: LocalizedStringResource(stringLiteral: spoken), supporting: "Your 5 replies"), view: RepliesSnippet(replies: replies))
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
