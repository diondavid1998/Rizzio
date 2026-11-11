import Foundation

enum RizzError: LocalizedError {
    case notConfigured
    case server(String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Open Rizzio → Setup and add your server URL and token."
        case .server(let msg): return msg
        case .network(let msg): return "Network problem: \(msg)"
        }
    }
}

struct RizzResult: Decodable {
    let generationId: String
    let context: String
    let replies: [Reply]
}

/// Talks to the Rizzio backend (backend/ folder).
enum RizzAPI {
    private struct ImagePayload: Encodable { let data: String; let mediaType: String }
    private struct ErrorBody: Decodable { let error: String }
    private struct Empty: Decodable {}

    // MARK: Replies

    private struct ReplyPayload: Encodable {
        let mode: RizzMode
        let tone: String
        let text: String?
        let draft: String?
        let image: ImagePayload?
        var instruction: String? = nil
        var previous: [String]? = nil
        var length: String? = nil
    }

    static func generate(mode: RizzMode, tone: Tone? = nil, jpeg: Data? = nil, text: String? = nil, draft: String? = nil,
                         instruction: String? = nil, previous: [String] = [], length: ReplyLength? = nil) async throws -> RizzResult {
        let payload = ReplyPayload(
            mode: mode,
            tone: (tone ?? SharedStore.shared.tone).rawValue,
            text: text,
            draft: draft,
            image: jpeg.map { ImagePayload(data: $0.base64EncodedString(), mediaType: "image/jpeg") },
            instruction: instruction,
            previous: previous.isEmpty ? nil : previous,
            length: (length ?? SharedStore.shared.replyLength).rawValue
        )
        return try await send("POST", "v1/replies", body: payload, timeout: 60)
    }

    /// Generates and saves the result so the keyboard picks it up.
    @discardableResult
    static func generateAndStore(
        mode: RizzMode,
        tone: Tone? = nil,
        jpeg: Data? = nil,
        text: String? = nil,
        draft: String? = nil,
        keepScreenshot: Bool = false,
        instruction: String? = nil,
        previous: [String] = []
    ) async throws -> SuggestionBatch {
        let store = SharedStore.shared
        let result: RizzResult
        if store.engine == .free {
            // Apple Intelligence writes the replies on the phone; the server only stores them (if reachable).
            let me = try? await RizzAPI.me()
            let local = try await OnDeviceAI.replies(mode: mode, tone: tone ?? store.tone, jpeg: jpeg, text: text,
                                                     draft: draft, persona: store.persona, me: me,
                                                     instruction: instruction, previous: previous,
                                                     length: store.replyLength)
            let saved = try? await saveGeneration(mode: mode, tone: tone ?? store.tone, context: local.context, replies: local.replies)
            result = RizzResult(generationId: saved ?? "", context: local.context, replies: local.replies)
        } else {
            result = try await generate(mode: mode, tone: tone, jpeg: jpeg, text: text, draft: draft,
                                        instruction: instruction, previous: previous)
        }
        if jpeg != nil, keepScreenshot { store.saveScreenshot(jpeg) }
        let batch = SuggestionBatch(
            generationId: result.generationId.isEmpty ? nil : result.generationId,
            context: result.context,
            replies: result.replies,
            mode: mode,
            createdAt: Date(),
            hasScreenshot: jpeg != nil,
            sourceText: text,
            sourceDraft: draft
        )
        store.latestBatch = batch
        return batch
    }

    // MARK: Reference library

    struct InspirationItem: Codable { let them: String; let reply: String }
    private struct InspirationRequest: Codable { let text: String; let mode: String; let limit: Int }
    private struct InspirationResponse: Codable { let items: [InspirationItem]; let own: [String]? }

    /// Relevant example exchanges from the server's built-in library, plus the user's own messages on the same topic,
    /// for the on-phone model. Never fails: empty if offline.
    static func inspiration(text: String, mode: RizzMode, limit: Int = 4) async -> (items: [InspirationItem], own: [String]) {
        let request = InspirationRequest(text: String(text.prefix(3000)), mode: mode.rawValue, limit: limit)
        let response: InspirationResponse? = try? await send("POST", "v1/inspiration", body: request, timeout: 5)
        return (response?.items ?? [], response?.own ?? [])
    }

    // MARK: Persona

    private struct PersonaEnvelope: Codable { let persona: Persona }

    static func persona() async throws -> Persona {
        let result: PersonaEnvelope = try await send("GET", "v1/me/persona")
        SharedStore.shared.persona = result.persona
        return result.persona
    }

    static func savePersona(_ persona: Persona) async throws {
        let result: PersonaEnvelope = try await send("PUT", "v1/me/persona", body: PersonaEnvelope(persona: persona))
        SharedStore.shared.persona = result.persona
    }

    static func autoTune() async throws -> AutoTuneResult {
        if SharedStore.shared.engine == .free { return try await OnDeviceAI.autoTune(me: try await me()) }
        return try await send("POST", "v1/me/persona/autotune", timeout: 90)
    }

    // MARK: Free mode storage (no AI on the server)

    private struct GenerationPayload: Encodable { let mode: RizzMode; let tone: String; let context: String; let replies: [Reply] }
    private struct GenerationSaved: Decodable { let generationId: String }

    static func saveGeneration(mode: RizzMode, tone: Tone, context: String, replies: [Reply]) async throws -> String {
        let saved: GenerationSaved = try await send("POST", "v1/generations",
                                                    body: GenerationPayload(mode: mode, tone: tone.rawValue, context: context, replies: replies))
        return saved.generationId
    }

    private struct ExamplesPayload: Encodable { let texts: [String] }
    private struct ProfilePayload: Codable { let voiceProfile: String }

    private struct PreviewPayload: Encodable {
        let mode: RizzMode
        let tone: String
        let text: String?
        let image: ImagePayload?
        let preview: Bool
        let persona: Persona
    }

    private struct PreviewResult: Decodable { let context: String; let replies: [Reply] }

    /// Test drive: replies with unsaved settings. Not saved to History and not learned from.
    static func preview(persona: Persona, text: String?, jpeg: Data?, mode: RizzMode = .prompt) async throws -> (context: String, replies: [Reply]) {
        if SharedStore.shared.engine == .free {
            let local = try await OnDeviceAI.replies(mode: jpeg != nil ? .auto : mode, tone: .me, jpeg: jpeg, text: text,
                                                     draft: nil, persona: persona, me: try? await me())
            return (local.context, local.replies)
        }
        let payload = PreviewPayload(
            mode: mode, tone: Tone.me.rawValue, text: text,
            image: jpeg.map { ImagePayload(data: $0.base64EncodedString(), mediaType: "image/jpeg") },
            preview: true, persona: persona
        )
        let result: PreviewResult = try await send("POST", "v1/replies", body: payload, timeout: 60)
        return (result.context, result.replies)
    }

    // MARK: Learning

    private struct FeedbackPayload: Encodable {
        let generationId: String?
        let replyIndex: Int?
        let kind: FeedbackKind
        let text: String?
    }

    static func feedback(_ kind: FeedbackKind, generationId: String?, replyIndex: Int? = nil, text: String? = nil) async throws {
        let _: Empty = try await send("POST", "v1/feedback", body: FeedbackPayload(generationId: generationId, replyIndex: replyIndex, kind: kind, text: text))
    }

    /// Fire-and-forget version for the keyboard: learning should never get in the way of typing.
    static func feedbackInBackground(_ kind: FeedbackKind, generationId: String?, replyIndex: Int? = nil, text: String? = nil) {
        Task.detached { try? await RizzAPI.feedback(kind, generationId: generationId, replyIndex: replyIndex, text: text) }
    }

    static func me() async throws -> MeResponse {
        try await send("GET", "v1/me")
    }

    private struct MePayload: Encodable { let aboutMe: String; let styleExamples: [String] }

    static func updateMe(aboutMe: String, styleExamples: [String]) async throws {
        let _: Empty = try await send("PUT", "v1/me", body: MePayload(aboutMe: aboutMe, styleExamples: styleExamples))
    }

    private struct LearnPayload: Encodable { let image: ImagePayload }
    private struct LearnResult: Decodable { let learned: [String] }

    /// Teach Rizzio from a screenshot of one of your own chats. Returns the messages it learned.
    static func learn(fromScreenshot jpeg: Data) async throws -> [String] {
        if SharedStore.shared.engine == .free {
            // Read the chat on the phone; only the text of your own messages goes to the server.
            let mine = try OnDeviceAI.myMessages(fromScreenshot: jpeg)
            if !mine.isEmpty {
                let _: Empty = try await send("POST", "v1/me/examples", body: ExamplesPayload(texts: mine))
            }
            return mine
        }
        let result: LearnResult = try await send(
            "POST", "v1/learn/screenshot",
            body: LearnPayload(image: ImagePayload(data: jpeg.base64EncodedString(), mediaType: "image/jpeg")),
            timeout: 60
        )
        return result.learned
    }

    private struct RebuildResult: Decodable { let voiceProfile: String }

    static func rebuildProfile() async throws -> String {
        if SharedStore.shared.engine == .free {
            let profile = try await OnDeviceAI.styleProfile(me: try await me())
            let saved: ProfilePayload = try await send("PUT", "v1/me/profile", body: ProfilePayload(voiceProfile: profile))
            return saved.voiceProfile
        }
        let result: RebuildResult = try await send("POST", "v1/me/rebuild", timeout: 90)
        return result.voiceProfile
    }

    static func deleteExample(id: Int) async throws {
        let _: Empty = try await send("DELETE", "v1/me/examples/\(id)")
    }

    static func resetMemory() async throws {
        let _: Empty = try await send("DELETE", "v1/me/memory")
    }

    private struct HistoryResult: Decodable { let items: [HistoryItem] }

    static func history() async throws -> [HistoryItem] {
        let result: HistoryResult = try await send("GET", "v1/history?limit=50")
        return result.items
    }

    // MARK: Importing exported chats

    /// Sends a file (WhatsApp .txt, Instagram/Telegram JSON, CSV, zip...) for the server to read. No AI involved.
    static func previewImport(filename: String, data: Data) async throws -> ImportPreview {
        let name = filename.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "upload"
        return try await sendRaw("v1/learn/file/preview?name=\(name)", data: data)
    }

    private struct CommitPayload: Encodable { let importId: String; let sender: String }
    private struct CommitResult: Decodable { let added: Int; let considered: Int }

    /// Saves only the chosen sender's messages. Returns how many new ones were learned.
    static func commitImport(importId: String, sender: String) async throws -> Int {
        let result: CommitResult = try await send("POST", "v1/learn/file/commit", body: CommitPayload(importId: importId, sender: sender))
        return result.added
    }

    static func examples(offset: Int, limit: Int = 50, query: String = "") async throws -> ExamplesPage {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await send("GET", "v1/me/examples?offset=\(offset)&limit=\(limit)&q=\(q)")
    }

    // MARK: Transport

    private static func sendRaw<R: Decodable>(_ path: String, data: Data) async throws -> R {
        let store = SharedStore.shared
        let base = store.serverURL.hasSuffix("/") ? store.serverURL : store.serverURL + "/"
        guard store.isConfigured, let url = URL(string: base + path) else { throw RizzError.notConfigured }
        var request = URLRequest(url: url, timeoutInterval: 120)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(store.appToken)", forHTTPHeaderField: "Authorization")
        request.setValue(store.userId, forHTTPHeaderField: "X-Rizzio-User")
        let (body, response): (Data, URLResponse)
        do {
            (body, response) = try await URLSession.shared.upload(for: request, from: data)
        } catch {
            throw RizzError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? JSONDecoder().decode(ErrorBody.self, from: body))?.error
                ?? (status == 413 ? "That file is too big (40 MB max). Unzip it and pick just the messages files." : "Server error (\(status)).")
            throw RizzError.server(msg)
        }
        do { return try JSONDecoder().decode(R.self, from: body) } catch { throw RizzError.server("Unexpected response from the server.") }
    }

    private struct NoBody: Encodable {}

    private static func send<R: Decodable>(_ method: String, _ path: String, timeout: TimeInterval = 20) async throws -> R {
        try await send(method, path, body: Optional<NoBody>.none, timeout: timeout)
    }

    private static func send<B: Encodable, R: Decodable>(_ method: String, _ path: String, body: B?, timeout: TimeInterval = 20) async throws -> R {
        let store = SharedStore.shared
        let base = store.serverURL.hasSuffix("/") ? store.serverURL : store.serverURL + "/"
        guard store.isConfigured, let url = URL(string: base + path) else { throw RizzError.notConfigured }

        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(store.appToken)", forHTTPHeaderField: "Authorization")
        request.setValue(store.userId, forHTTPHeaderField: "X-Rizzio-User")
        if let body { request.httpBody = try JSONEncoder().encode(body) }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw RizzError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Server error (\(status))."
            throw RizzError.server(msg)
        }
        do {
            return try JSONDecoder().decode(R.self, from: data)
        } catch {
            throw RizzError.server("Unexpected response from the server.")
        }
    }
}
