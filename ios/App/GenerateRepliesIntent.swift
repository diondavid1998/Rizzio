import AppIntents
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
        }
    }

    @Parameter(title: "Type", default: .auto)
    var kind: ScreenKind

    @Parameter(title: "Tone (optional)")
    var tone: ToneOption?

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
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
        let batch = try await RizzAPI.generateAndStore(
            mode: mode,
            tone: tone.flatMap { Tone(rawValue: $0.rawValue) },
            jpeg: jpeg,
            keepScreenshot: true,
            earlier: earlier
        )
        store.addProfileScreen(jpeg)
        let list = batch.replies.enumerated().map { "\($0.offset + 1). \($0.element.text)" }.joined(separator: "\n")
        return .result(
            value: list,
            dialog: IntentDialog(stringLiteral: topReplyBanner(batch))
        )
    }
}

/// The banner after the Action Button / Back Tap: all 5 replies as bullets, one per line, best first.
private func topReplyBanner(_ batch: SuggestionBatch) -> String {
    guard !batch.replies.isEmpty else { return "No replies this time. Try another screenshot." }
    return batch.replies.map { "• \($0.text)" }.joined(separator: "\n")
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
    case witty, humor, flirty, chill, bold, sweet, corny
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Tone"
    static var caseDisplayRepresentations: [ToneOption: DisplayRepresentation] = [
        .witty: "Witty", .humor: "Humor", .flirty: "Flirty", .chill: "Chill", .bold: "Bold", .sweet: "Sweet", .corny: "Corny",
    ]
}
