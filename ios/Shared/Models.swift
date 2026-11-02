import Foundation

enum RizzMode: String, Codable {
    case prompt   // a dating-app profile prompt
    case chat     // an ongoing conversation
    case draft    // improve what the user already typed
}

enum Tone: String, CaseIterable, Codable, Identifiable {
    case witty, flirty, chill, bold, sweet, corny
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct Reply: Codable, Hashable {
    let text: String
    let angle: String
}

/// One set of suggestions, saved in the shared App Group so the keyboard can show it.
struct SuggestionBatch: Codable {
    let context: String
    let replies: [Reply]
    let mode: RizzMode
    let createdAt: Date
    /// True when a screenshot is saved alongside, so the keyboard can regenerate with another tone.
    let hasScreenshot: Bool
}
