import Foundation

/// How you want Rizzio to sound. Keys must match backend/src/persona.js.
struct Persona: Codable, Equatable {
    var sliders: [String: Double]
    var toggles: [String: Bool]
    var goal: String
    var avoid: String
    var notes: String

    static let `default` = Persona(
        sliders: Dictionary(uniqueKeysWithValues: SliderSpec.all.map { ($0.key, $0.defaultValue) }),
        toggles: ["lowercase": false, "noEmoji": false, "noPickupLines": true, "mirrorEnergy": true, "useMyInterests": true, "noDoubleText": true],
        goal: "match",
        avoid: "",
        notes: ""
    )

    func value(_ key: String) -> Double { sliders[key] ?? SliderSpec.byKey[key]?.defaultValue ?? 50 }
    func isOn(_ key: String) -> Bool { toggles[key] ?? false }
}

struct SliderSpec: Identifiable {
    enum Group: String, CaseIterable {
        case vibe = "Vibe"
        case style = "Style"
        case strategy = "Strategy"
    }

    let key: String
    let title: String
    let icon: String
    let left: String
    let right: String
    let group: Group
    let defaultValue: Double
    var id: String { key }

    static let all: [SliderSpec] = [
        .init(key: "flirt", title: "Flirty", icon: "heart.fill", left: "Friendly", right: "Flirty", group: .vibe, defaultValue: 55),
        .init(key: "humor", title: "Humor", icon: "face.smiling", left: "Sincere", right: "Jokey", group: .vibe, defaultValue: 65),
        .init(key: "boldness", title: "Boldness", icon: "bolt.fill", left: "Easygoing", right: "Daring", group: .vibe, defaultValue: 55),
        .init(key: "warmth", title: "Warmth", icon: "sun.max.fill", left: "Cool", right: "Affectionate", group: .vibe, defaultValue: 60),
        .init(key: "spice", title: "Spice", icon: "flame.fill", left: "PG", right: "Cheeky", group: .vibe, defaultValue: 25),
        .init(key: "humorStyle", title: "Humor style", icon: "theatermasks.fill", left: "Goofy", right: "Deadpan", group: .style, defaultValue: 50),
        .init(key: "tease", title: "Teasing", icon: "hand.point.right.fill", left: "Supportive", right: "Roasty", group: .style, defaultValue: 45),
        .init(key: "length", title: "Length", icon: "text.alignleft", left: "Few words", right: "Paragraph", group: .style, defaultValue: 35),
        .init(key: "emoji", title: "Emoji", icon: "face.dashed", left: "None", right: "Lots", group: .style, defaultValue: 15),
        .init(key: "polish", title: "Polish", icon: "sparkles", left: "Casual", right: "Proper", group: .style, defaultValue: 25),
        .init(key: "curiosity", title: "Questions", icon: "questionmark.bubble.fill", left: "Statements", right: "Always ask", group: .strategy, defaultValue: 60),
        .init(key: "pace", title: "Pace", icon: "hare.fill", left: "Slow burn", right: "Ask them out", group: .strategy, defaultValue: 40),
    ]

    static let byKey = Dictionary(uniqueKeysWithValues: all.map { ($0.key, $0) })
}

struct ToggleSpec: Identifiable {
    let key: String
    let title: String
    let subtitle: String
    var id: String { key }

    static let all: [ToggleSpec] = [
        .init(key: "lowercase", title: "all lowercase", subtitle: "texts like this, no capitals"),
        .init(key: "noPickupLines", title: "No pickup lines", subtitle: "skip the canned, cheesy stuff"),
        .init(key: "mirrorEnergy", title: "Mirror their energy", subtitle: "match how much they put in"),
        .init(key: "useMyInterests", title: "Use my interests", subtitle: "work in things from About you"),
        .init(key: "noDoubleText", title: "Never needy", subtitle: "no chasing, no guilt trips"),
    ]
}

struct GoalSpec: Identifiable {
    let key: String
    let title: String
    let icon: String
    var id: String { key }

    static let all: [GoalSpec] = [
        .init(key: "match", title: "Get the match", icon: "heart.circle"),
        .init(key: "keepGoing", title: "Keep it going", icon: "bubble.left.and.bubble.right"),
        .init(key: "number", title: "Get their number", icon: "phone"),
        .init(key: "date", title: "Set up a date", icon: "calendar"),
        .init(key: "friend", title: "Just friends", icon: "person.2"),
    ]
}

/// One-tap starting points. Only the sliders listed change; everything else stays as you set it.
struct PersonaPreset: Identifiable {
    let name: String
    let emoji: String
    let sliders: [String: Double]
    var id: String { name }

    static let all: [PersonaPreset] = [
        .init(name: "Smooth", emoji: "😎", sliders: ["flirt": 75, "humor": 55, "boldness": 70, "warmth": 55, "tease": 45, "humorStyle": 70, "length": 30, "emoji": 5, "polish": 40, "pace": 60]),
        .init(name: "Golden retriever", emoji: "🐶", sliders: ["flirt": 50, "humor": 70, "boldness": 45, "warmth": 95, "tease": 15, "humorStyle": 20, "emoji": 55, "curiosity": 80]),
        .init(name: "Dry wit", emoji: "🍸", sliders: ["flirt": 45, "humor": 85, "humorStyle": 95, "tease": 70, "warmth": 35, "emoji": 0, "length": 20, "polish": 30]),
        .init(name: "Hopeless romantic", emoji: "🌹", sliders: ["flirt": 80, "warmth": 90, "humor": 40, "spice": 15, "length": 60, "polish": 55, "pace": 55]),
        .init(name: "Chaos", emoji: "🌀", sliders: ["humor": 95, "humorStyle": 10, "boldness": 90, "tease": 75, "spice": 45, "emoji": 40, "polish": 5]),
        .init(name: "Chill", emoji: "🧊", sliders: ["flirt": 40, "humor": 55, "boldness": 30, "warmth": 50, "length": 15, "emoji": 10, "polish": 10, "pace": 25]),
    ]
}

/// Slider values Rizzio suggests from how you actually text.
struct AutoTuneResult: Decodable {
    struct Setting: Decodable, Identifiable {
        let key: String
        let value: Double
        let reason: String
        var id: String { key }
    }
    let settings: [Setting]
    let lowercase: Bool
}

extension Persona {
    /// Applies the hard rules (No emoji, all lowercase) to finished replies, whichever AI wrote them.
    func enforce(_ replies: [Reply]) -> [Reply] {
        replies.compactMap { reply in
            var text = reply.text
            if isOn("noEmoji") { text = text.withoutEmoji }
            if isOn("lowercase") { text = text.lowercased() }
            return text.isEmpty ? nil : Reply(text: text, angle: reply.angle)
        }
    }
}

extension String {
    /// The text with emoji (including skin tones, flags and joined emoji) removed and spacing tidied.
    var withoutEmoji: String {
        let kept = unicodeScalars.filter { scalar in
            let p = scalar.properties
            if scalar.value == 0x200D || scalar.value == 0xFE0F || scalar.value == 0x20E3 { return false }
            if (0x1F3FB...0x1F3FF).contains(scalar.value) || (0x1F1E6...0x1F1FF).contains(scalar.value) { return false }
            // Digits, # and * count as "emoji" in Unicode; only drop real pictographs.
            return !(p.isEmojiPresentation || (p.isEmoji && scalar.value > 0x238C))
        }
        var out = String(String.UnicodeScalarView(kept))
        while out.contains("  ") { out = out.replacingOccurrences(of: "  ", with: " ") }
        for mark in [".", ",", "!", "?"] { out = out.replacingOccurrences(of: " " + mark, with: mark) }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
