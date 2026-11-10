import Foundation

enum RizzMode: String, Codable {
    case auto     // let the AI work out profile vs chat
    case prompt   // a dating-app profile prompt
    case chat     // an ongoing conversation
    case draft    // improve what the user already typed
}

enum Tone: String, CaseIterable, Codable, Identifiable {
    /// Follow your Persona settings as they are.
    case me
    case witty, humor, flirty, chill, bold, sweet, corny
    var id: String { rawValue }
    var label: String { self == .me ? "Me" : rawValue.capitalized }
    /// What the tone means to the AI (the server has the same list in prompts.js).
    var hint: String {
        switch self {
        case .me: return "the user's own persona settings"
        case .witty: return "witty: clever wordplay and quick comebacks"
        case .humor: return "humor: laugh-out-loud funny, a joke, an absurd bit or a silly hypothetical"
        case .flirty: return "flirty: openly interested, compliments with a wink"
        case .chill: return "chill: low-key and relaxed"
        case .bold: return "bold: confident and direct, a daring take or a clear ask"
        case .sweet: return "sweet: warm and genuine"
        case .corny: return "corny: on-purpose cheesy puns played for laughs"
        }
    }
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
    /// The copied text or draft these replies were written for, so the keyboard can rewrite them without a screenshot.
    var sourceText: String? = nil
    var sourceDraft: String? = nil
}

/// What the server found in an exported chat file, before you say which sender is you.
struct ImportPreview: Decodable, Identifiable {
    struct Sender: Decodable, Identifiable, Hashable {
        let name: String
        let count: Int
        let samples: [String]
        var id: String { name }
    }
    let importId: String
    let format: String
    let total: Int
    let guess: String?
    let senders: [Sender]
    var id: String { importId }
}

/// One page of the messages Rizzio learned from.
struct ExamplesPage: Decodable {
    let items: [MeResponse.Learned]
    let total: Int
}

/// Which AI writes the replies.
enum Engine: String, Codable, CaseIterable, Identifiable {
    case free      // Apple Intelligence on the iPhone, $0
    case premium   // Claude Haiku on the Rizzio server
    var id: String { rawValue }
    var label: String { self == .free ? "Free" : "Premium" }
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
