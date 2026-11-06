import AppIntents
import Foundation

/// Shows up in the Shortcuts app as "Get Rizzio Replies".
/// Shortcut: Take Screenshot → Get Rizzio Replies. Assign it to Back Tap.
/// Runs in the background, so you never leave Hinge.
struct GenerateRepliesIntent: AppIntent {
    static var title: LocalizedStringResource = "Get Rizzio Replies"
    static var description = IntentDescription("Reads a screenshot (a dating profile or a chat) and writes 5 replies. Open the Rizzio keyboard to use them.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Screenshot", supportedTypeIdentifiers: ["public.image"])
    var screenshot: IntentFile

    @Parameter(title: "Type", default: .auto)
    var kind: ScreenKind

    @Parameter(title: "Tone (optional)")
    var tone: ToneOption?

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let jpeg = ImageTools.compressedJPEG(from: screenshot.data) else {
            throw RizzError.server("Couldn't read that screenshot.")
        }
        let mode: RizzMode = kind == .chat ? .chat : .prompt
        let batch = try await RizzAPI.generateAndStore(
            mode: mode,
            tone: tone.flatMap { Tone(rawValue: $0.rawValue) },
            jpeg: jpeg,
            keepScreenshot: true
        )
        let list = batch.replies.enumerated().map { "\($0.offset + 1). \($0.element.text)" }.joined(separator: "\n")
        return .result(
            value: list,
            dialog: IntentDialog(stringLiteral: "\(batch.replies.count) replies ready. Tap the comment box and switch to the Rizzio keyboard.")
        )
    }
}

enum ScreenKind: String, AppEnum {
    case auto, profile, chat
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Screen type"
    static var caseDisplayRepresentations: [ScreenKind: DisplayRepresentation] = [
        .auto: "Auto (profile)",
        .profile: "Dating profile",
        .chat: "Chat conversation",
    ]
}

enum ToneOption: String, AppEnum {
    case witty, flirty, chill, bold, sweet, corny
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Tone"
    static var caseDisplayRepresentations: [ToneOption: DisplayRepresentation] = [
        .witty: "Witty", .flirty: "Flirty", .chill: "Chill", .bold: "Bold", .sweet: "Sweet", .corny: "Corny",
    ]
}
