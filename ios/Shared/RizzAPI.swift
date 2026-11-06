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
    }

    static func generate(mode: RizzMode, tone: Tone? = nil, jpeg: Data? = nil, text: String? = nil, draft: String? = nil) async throws -> RizzResult {
        let payload = ReplyPayload(
            mode: mode,
            tone: (tone ?? SharedStore.shared.tone).rawValue,
            text: text,
            draft: draft,
            image: jpeg.map { ImagePayload(data: $0.base64EncodedString(), mediaType: "image/jpeg") }
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
        keepScreenshot: Bool = false
    ) async throws -> SuggestionBatch {
        let result = try await generate(mode: mode, tone: tone, jpeg: jpeg, text: text, draft: draft)
        let store = SharedStore.shared
        if jpeg != nil, keepScreenshot { store.saveScreenshot(jpeg) }
        let batch = SuggestionBatch(
            generationId: result.generationId,
            context: result.context,
            replies: result.replies,
            mode: mode,
            createdAt: Date(),
            hasScreenshot: jpeg != nil
        )
        store.latestBatch = batch
        return batch
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
        let result: LearnResult = try await send(
            "POST", "v1/learn/screenshot",
            body: LearnPayload(image: ImagePayload(data: jpeg.base64EncodedString(), mediaType: "image/jpeg")),
            timeout: 60
        )
        return result.learned
    }

    private struct RebuildResult: Decodable { let voiceProfile: String }

    static func rebuildProfile() async throws -> String {
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

    // MARK: Transport

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
