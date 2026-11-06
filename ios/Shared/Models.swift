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
    let generationId: String?
    let context: String
    let replies: [Reply]
    let mode: RizzMode
    let createdAt: Date
    /// True when a screenshot is saved alongside, so the keyboard can regenerate with another tone.
    let hasScreenshot: Bool
}

/// What the agent learns from. Mirrors the backend's signal kinds.
enum FeedbackKind: String, Codable {
    case picked    // chose this reply
    case edited    // changed it before sending (text = what was sent)
    case rejected  // "not me"
    case match     // it got a match
    case replied   // they replied
    case ignored   // no response
}

/// The reply the keyboard last inserted, so it can notice if you edited it.
struct PendingInsert: Codable {
    let generationId: String
    let replyIndex: Int
    let text: String
}

/// What Rizzio has learned about you (GET /v1/me).
struct MeResponse: Decodable {
    struct Learned: Decodable, Identifiable, Hashable {
        let id: Int
        let text: String
        let source: String
    }
    struct Stats: Decodable {
        let generations: Int
        let examples: Int
        let wins: Int
        let picks: Int
    }
    let aboutMe: String
    let styleExamples: [String]
    let voiceProfile: String
    let profileUpdatedAt: String?
    let learnedExamples: [Learned]
    let stats: Stats
}

struct HistoryItem: Decodable, Identifiable {
    struct Signal: Decodable, Hashable {
        let kind: String
        let replyIndex: Int?
        let text: String?
    }
    let id: String
    let mode: String
    let tone: String
    let context: String
    let replies: [Reply]
    let createdAt: String
    let signals: [Signal]

    /// The reply you picked, if any.
    var pickedIndex: Int? { signals.last(where: { $0.kind == "picked" || $0.kind == "edited" })?.replyIndex }
    var outcome: String? { signals.last(where: { ["match", "replied", "ignored"].contains($0.kind) })?.kind }
    var rejected: Set<Int> { Set(signals.filter { $0.kind == "rejected" }.compactMap(\.replyIndex)) }
}
