import Foundation
import UIKit
import Vision
#if canImport(FoundationModels)
import FoundationModels
#endif

/// The "Free" engine: Apple Intelligence on the iPhone. Nothing is sent to Claude, so it costs nothing.
/// - Screenshots are read with Apple's on-device text recognition (Vision).
/// - Replies, the texting-style summary and slider suggestions come from Apple's on-device model.
enum OnDeviceAI {
    // MARK: Availability

    /// Why Free mode can't run right now, or nil if it can.
    static var unavailableReason: String? {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return nil
            case .unavailable(.deviceNotEligible):
                return "This iPhone doesn't support Apple Intelligence. Switch to Premium in Setup."
            case .unavailable(.appleIntelligenceNotEnabled):
                return "Turn on Apple Intelligence (Settings → Apple Intelligence & Siri), or switch to Premium in Setup."
            case .unavailable(.modelNotReady):
                return "Apple Intelligence is still downloading. Try again in a few minutes, or switch to Premium."
            case .unavailable:
                return "Apple Intelligence isn't available right now. Switch to Premium in Setup."
            }
        }
        #endif
        return "Free mode needs iOS 26 or later with Apple Intelligence. Switch to Premium in Setup."
    }

    // MARK: Reading screenshots (works on any iOS version)

    struct ChatLine {
        enum Side { case me, them, unknown }
        let text: String
        let side: Side
    }

    /// Reads a screenshot. In chats, text on the right is yours and text on the left is theirs.
    static func read(_ imageData: Data) throws -> [ChatLine] {
        guard let cgImage = UIImage(data: imageData)?.cgImage else { throw RizzError.server("Couldn't read that screenshot.") }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: cgImage).perform([request])
        let observations = (request.results ?? [])
            .filter { $0.boundingBox.maxY < 0.94 } // skip the status bar
            .sorted { $0.boundingBox.maxY > $1.boundingBox.maxY } // top to bottom (Vision's origin is bottom-left)

        var lines: [ChatLine] = []
        var lastBottom: CGFloat = 1
        for obs in observations {
            guard let text = obs.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces), !text.isEmpty else { continue }
            let box = obs.boundingBox
            let side: ChatLine.Side = box.minX > 0.3 && box.maxX > 0.75 ? .me : (box.minX < 0.2 && box.maxX < 0.85 ? .them : .unknown)
            // Lines of the same bubble sit close together: merge them into one message.
            if let previous = lines.last, previous.side == side, side != .unknown, lastBottom - box.maxY < 0.02 {
                lines[lines.count - 1] = ChatLine(text: previous.text + " " + text, side: side)
            } else {
                lines.append(ChatLine(text: text, side: side))
            }
            lastBottom = box.minY
        }
        return lines
    }

    /// The text of a screenshot as a transcript the model can follow.
    static func transcript(_ lines: [ChatLine]) -> String {
        let looksLikeChat = lines.contains { $0.side == .me } && lines.contains { $0.side == .them }
        let text = lines.map { line -> String in
            guard looksLikeChat else { return line.text }
            switch line.side {
            case .me: return "Me: \(line.text)"
            case .them: return "Them: \(line.text)"
            case .unknown: return line.text
            }
        }.joined(separator: "\n")
        return String(text.prefix(2500))
    }

    /// Your own messages in a chat screenshot (the right-hand bubbles), for Train.
    static func myMessages(fromScreenshot imageData: Data) throws -> [String] {
        try read(imageData).filter { $0.side == .me }.map(\.text).filter { $0.count > 1 }
    }

    // MARK: Prompt pieces

    static let instructions = """
    You write messages the user will send on dating apps and in chats, in the user's own texting style.
    Write exactly 5 different messages. Each one is short (6 to 25 words), specific to a detail in what they said or wrote, \
    and easy to answer: end with a playful question, a light challenge, or a this-or-that.
    Be confident and warm. Never crude, no sexual content, no comments on bodies, no cheesy pickup lines, no em dashes.
    No stock reactions the user doesn't use ("bold pick", "bold move", "I respect it", "elite", "iconic", "I'll die on that hill"), and never start two messages the same way.
    Openers carry meaning: "wait" only for a real double take at something surprising, "ngl"/"honestly" only to own up to an honest opinion, \
    "lowkey" for something understated, "ok but" to push back or pivot, "lol" only when something is funny. Only use openers the user uses, in at most two messages.
    Follow the persona settings. The user's own messages decide how you sound and think: copy their wording, pet phrases, \
    length, capitalization, slang, emoji, what they notice and how they react. Example exchanges from other people are only ideas.
    First read what they sent: is it a question, several questions, a rhetorical question, a challenge or hot take, \
    a tease, a story, a compliment, plans, or a dating-profile prompt? Then reply in the right form: answer real questions \
    (all of them) and hand it back, play along with rhetorical ones, push back playfully on challenges, tease back on teases, \
    react to the specific detail of a story, and riff on a profile prompt.
    Make the 5 messages different forms that all fit what was said, best one first. At least one asks them a specific, fun question back.
    """

    static func personaText(_ persona: Persona) -> String {
        var parts = SliderSpec.all.map { spec in
            "- \(spec.title): \(Int(persona.value(spec.key)))/100 (0 = \(spec.left), 100 = \(spec.right))"
        }
        if persona.isOn("lowercase") { parts.append("- Write everything in lowercase.") }
        if persona.isOn("noEmoji") { parts.append("- No emoji at all.") }
        if persona.isOn("noPhotos") { parts.append("- Reply only to their written prompts and messages, never to their photos.") }
        if persona.isOn("noPickupLines") { parts.append("- No canned pickup lines.") }
        if persona.isOn("noDoubleText") { parts.append("- Never needy or chasing.") }
        if let goal = GoalSpec.all.first(where: { $0.key == persona.goal }) { parts.append("- Goal: \(goal.title).") }
        if !persona.avoid.trimmingCharacters(in: .whitespaces).isEmpty { parts.append("- Never mention: \(persona.avoid).") }
        if !persona.notes.trimmingCharacters(in: .whitespaces).isEmpty { parts.append("- Also: \(persona.notes)") }
        return "Persona settings:\n" + parts.joined(separator: "\n")
    }

    static func styleText(_ me: MeResponse?) -> String {
        guard let me else { return "" }
        var parts: [String] = []
        if !me.voiceProfile.isEmpty { parts.append("How the user texts:\n\(me.voiceProfile.prefix(600))") }
        if !me.aboutMe.isEmpty { parts.append("About the user: \(me.aboutMe.prefix(300))") }
        let own = me.styleExamples + me.learnedExamples.filter { $0.source != "picked" }.map(\.text)
        if !own.isEmpty { parts.append("Messages the user really sent:\n" + own.prefix(12).map { "- \($0)" }.joined(separator: "\n")) }
        return parts.joined(separator: "\n\n")
    }

    static func task(mode: RizzMode, tone: Tone) -> String {
        let job: String
        switch mode {
        case .prompt: job = "Write 5 comments to send on this dating profile to get a match."
        case .chat: job = "Write 5 options for the user's next message (\"Me\") in this conversation, answering the last thing they said."
        case .draft: job = "Rewrite the user's draft 5 ways that keep the meaning but land better."
        case .auto: job = "If this is a dating profile, write 5 comments to get a match. If it's a conversation, write 5 options for the user's next message (\"Me\")."
        }
        return tone == .me ? job : job + " Tone: \(tone.hint). The tone changes what kind of message, not who is writing: keep the persona settings and the user's own voice."
    }

    // MARK: Generation

    struct Result {
        let context: String
        let replies: [Reply]
        var sideTopic: String? = nil
    }

    static func replies(mode: RizzMode, tone: Tone, jpeg: Data?, text: String?, draft: String?,
                        persona: Persona, me: MeResponse?,
                        instruction: String? = nil, previous: [String] = [],
                        length: ReplyLength = .auto, earlier: [Data] = [],
                        stance: String? = nil, stanceTopic: String? = nil) async throws -> Result {
        if let reason = unavailableReason { throw RizzError.server(reason) }
        var content: [String] = []
        for (i, screen) in earlier.enumerated() {
            if let lines = try? read(screen) { content.append("Earlier screen \(i + 1) (probably the same profile, scrolled up):\n" + transcript(lines)) }
        }
        if let jpeg { content.append("On screen now:\n" + transcript(try read(jpeg))) }
        if let text, !text.isEmpty { content.append("Their message or prompt:\n\(text.prefix(2500))") }
        if let draft, !draft.isEmpty { content.append("The user's draft:\n\(draft.prefix(600))") }
        if !previous.isEmpty { content.append("Earlier suggestions (write new ones):\n" + previous.prefix(5).map { "- \($0)" }.joined(separator: "\n")) }
        if let hint = length.hint { content.append("Length: every message must be \(hint). This overrides the usual 6 to 25 words.") }
        if let stance {
            let how = ["for": "agree with it and back it up", "against": "playfully disagree and argue the other side", "neutral": "stay playfully in the middle", "both": "split across the 5: some for, some against"][stance] ?? stance
            content.append("The user picked a side on \(stanceTopic ?? "this"): \(stance). Every message must \(how).")
        }
        if let instruction, !instruction.isEmpty { content.append("The user asked for this change: \(instruction.prefix(300)). Follow it exactly.") }
        // A few relevant exchanges from Rizzio's built-in library (ideas for angle, not the user's voice).
        let library = await RizzAPI.inspiration(text: content.joined(separator: "\n"), mode: mode)
        var referenceText = library.items.isEmpty ? "" :
            "Example exchanges for ideas only (other people, not the user: never copy their wording):\n" +
            library.items.map { "- \"\($0.them)\" → \"\($0.reply)\"" }.joined(separator: "\n")
        if !library.own.isEmpty {
            referenceText += (referenceText.isEmpty ? "" : "\n\n") +
                "Things the user has said about this before (their real words: talk and think like this):\n" +
                library.own.map { "- \($0)" }.joined(separator: "\n")
        }
        let prompt = [task(mode: mode, tone: tone), personaText(persona), styleText(me), referenceText, content.joined(separator: "\n\n")]
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let session = LanguageModelSession(instructions: instructions)
            let response = try await session.respond(to: prompt, generating: GeneratedReplies.self)
            let replies = persona.enforce(response.content.replies.map { Reply(text: $0.text, angle: $0.angle) })
            guard !replies.isEmpty else { throw RizzError.server("Apple Intelligence didn't write anything. Try again.") }
            let topic = response.content.sideTopic.trimmingCharacters(in: .whitespacesAndNewlines)
            return Result(context: response.content.context, replies: Array(replies.prefix(5)), sideTopic: topic.isEmpty ? nil : topic)
        }
        #endif
        throw RizzError.server(unavailableReason ?? "Free mode isn't available.")
    }

    /// Drafts the "About you" note (age, city, job, hobbies, humor) from the user's own messages.
    static func suggestAbout(me: MeResponse) async throws -> String {
        if let reason = unavailableReason { throw RizzError.server(reason) }
        let own = me.styleExamples + me.learnedExamples.filter { $0.source != "picked" }.map(\.text)
        guard !own.isEmpty || !me.voiceProfile.isEmpty else {
            throw RizzError.server("Upload some of your chats in Train first, so Rizzio has something to go on.")
        }
        let prompt = """
        From this person's own messages, write one short line of comma-separated facts about them, under 60 words, \
        like "27, NYC, nurse, into climbing and cooking, dry humor": age, city, job or school, hobbies, interests, humor. \
        Only facts they clearly state about themselves. No health, religion, ethnicity, sexuality, money, or other people's names. \
        Keep facts from their current note. Reply with just the line.
        Current note: \(me.aboutMe.prefix(300))
        How they text: \(me.voiceProfile.prefix(500))
        Their messages:
        \(own.prefix(40).map { "- \($0)" }.joined(separator: "\n"))
        """
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            return try await LanguageModelSession().respond(to: prompt).content.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        #endif
        throw RizzError.server(unavailableReason ?? "Free mode isn't available.")
    }

    /// Writes a short summary of how the user texts, from their own messages.
    static func styleProfile(me: MeResponse) async throws -> String {
        if let reason = unavailableReason { throw RizzError.server(reason) }
        let own = me.styleExamples + me.learnedExamples.filter { $0.source != "picked" }.map(\.text)
        guard !own.isEmpty else { throw RizzError.server("Upload some of your chats first so Rizzio knows how you text.") }
        let prompt = """
        Here are messages one person sent. Describe how they text in under 120 words, under these headings: \
        Voice (length, capitalization, punctuation, emoji, slang), Humor & energy, What to avoid. Quote short phrases they use.
        About them: \(me.aboutMe.prefix(300))
        Messages:
        \(own.prefix(30).map { "- \($0)" }.joined(separator: "\n"))
        """
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let session = LanguageModelSession()
            return try await session.respond(to: prompt).content.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        #endif
        throw RizzError.server(unavailableReason ?? "Free mode isn't available.")
    }

    /// Suggests slider values from the user's own messages.
    static func autoTune(me: MeResponse) async throws -> AutoTuneResult {
        if let reason = unavailableReason { throw RizzError.server(reason) }
        let own = me.styleExamples + me.learnedExamples.filter { $0.source != "picked" }.map(\.text)
        guard !own.isEmpty else { throw RizzError.server("Upload some of your chats first so Rizzio knows how you text.") }
        let sliders = SliderSpec.all.map { "- \($0.key): 0 = \($0.left), 100 = \($0.right)" }.joined(separator: "\n")
        let prompt = """
        Set sliders (0-100) to match how this person really texts. Only set sliders the messages clearly show.
        Sliders:
        \(sliders)
        Their messages:
        \(own.prefix(30).map { "- \($0)" }.joined(separator: "\n"))
        """
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let session = LanguageModelSession()
            let result = try await session.respond(to: prompt, generating: GeneratedTune.self).content
            let valid = Set(SliderSpec.all.map(\.key))
            let settings = result.settings
                .filter { valid.contains($0.key) }
                .map { AutoTuneResult.Setting(key: $0.key, value: Double(max(0, min(100, $0.value))), reason: $0.reason) }
            return AutoTuneResult(settings: settings, lowercase: result.lowercase)
        }
        #endif
        throw RizzError.server(unavailableReason ?? "Free mode isn't available.")
    }
}

#if canImport(FoundationModels)
@available(iOS 26.0, *)
@Generable
struct GeneratedReplies {
    @Guide(description: "What kind of message they sent: question, several questions, rhetorical, challenge, tease, story, compliment, plans, or profile prompt, and what a good reply must do")
    var read: String
    @Guide(description: "One short line naming what you replied to")
    var context: String
    @Guide(description: "If it invites taking a side (an opinion, hot take, this-or-that), the topic in 2-6 words; otherwise empty")
    var sideTopic: String
    @Guide(description: "Exactly five different messages, best first")
    var replies: [GeneratedReply]
}

@available(iOS 26.0, *)
@Generable
struct GeneratedReply {
    @Guide(description: "The message exactly as the user would send it")
    var text: String
    @Guide(description: "Two to four words naming how it responds, like answer + ask back, playful comeback, play along")
    var angle: String
}

@available(iOS 26.0, *)
@Generable
struct GeneratedTune {
    @Guide(description: "Sliders the messages clearly show")
    var settings: [GeneratedSetting]
    @Guide(description: "True if they write in all lowercase")
    var lowercase: Bool
}

@available(iOS 26.0, *)
@Generable
struct GeneratedSetting {
    @Guide(description: "The slider key exactly as listed")
    var key: String
    @Guide(description: "A value from 0 to 100")
    var value: Int
    @Guide(description: "Under 12 words, based on their real messages")
    var reason: String
}
#endif
