import Foundation

enum RizzError: LocalizedError {
    case notConfigured
    case server(String)
    case network(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Open the Rizzio app and add your server URL and token."
        case .server(let msg): return msg
        case .network(let msg): return "Network problem: \(msg)"
        }
    }
}

struct RizzResult: Decodable {
    let context: String
    let replies: [Reply]
}

/// Talks to the Rizzio backend (backend/ folder).
enum RizzAPI {
    private struct ImagePayload: Encodable { let data: String; let mediaType: String }
    private struct Payload: Encodable {
        let mode: RizzMode
        let tone: String
        let aboutMe: String
        let styleExamples: String
        let text: String?
        let draft: String?
        let image: ImagePayload?
    }
    private struct ErrorBody: Decodable { let error: String }

    static func generate(
        mode: RizzMode,
        tone: Tone? = nil,
        jpeg: Data? = nil,
        text: String? = nil,
        draft: String? = nil
    ) async throws -> RizzResult {
        let store = SharedStore.shared
        guard store.isConfigured,
              let url = URL(string: store.serverURL.hasSuffix("/") ? store.serverURL + "v1/replies" : store.serverURL + "/v1/replies")
        else { throw RizzError.notConfigured }

        let payload = Payload(
            mode: mode,
            tone: (tone ?? store.tone).rawValue,
            aboutMe: store.aboutMe,
            styleExamples: store.styleExamples,
            text: text,
            draft: draft,
            image: jpeg.map { ImagePayload(data: $0.base64EncodedString(), mediaType: "image/jpeg") }
        )

        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(store.appToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(payload)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw RizzError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let msg = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Server error (\(status))."
            throw RizzError.server(msg)
        }
        return try JSONDecoder().decode(RizzResult.self, from: data)
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
            context: result.context,
            replies: result.replies,
            mode: mode,
            createdAt: Date(),
            hasScreenshot: jpeg != nil
        )
        store.latestBatch = batch
        return batch
    }
}
