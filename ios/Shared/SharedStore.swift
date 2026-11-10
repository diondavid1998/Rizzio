import Foundation

/// Storage shared by the app, the Shortcut action and the keyboard (App Group).
final class SharedStore {
    static let shared = SharedStore()

    let groupID: String
    private let defaults: UserDefaults
    private let containerURL: URL?

    private init() {
        groupID = (Bundle.main.object(forInfoDictionaryKey: "RizzioAppGroup") as? String) ?? "group.rizzio"
        defaults = UserDefaults(suiteName: groupID) ?? .standard
        containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID)
    }

    /// False if the App Group isn't set up (or, in the keyboard, Full Access is off).
    var isGroupAvailable: Bool { containerURL != nil }

    // MARK: Identity

    /// Random id made on first launch. The server keeps your learned voice under it.
    var userId: String {
        if let testUser = ProcessInfo.processInfo.environment["RIZZIO_UITEST_USER"] { return testUser }
        if let id = defaults.string(forKey: "userId") { return id }
        let id = UUID().uuidString
        defaults.set(id, forKey: "userId")
        return id
    }

    // MARK: Server settings

    var serverURL: String {
        get { defaults.string(forKey: "serverURL") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "serverURL") }
    }

    var appToken: String {
        get { defaults.string(forKey: "appToken") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "appToken") }
    }

    var tone: Tone {
        get { Tone(rawValue: defaults.string(forKey: "tone") ?? "") ?? .me }
        set { defaults.set(newValue.rawValue, forKey: "tone") }
    }

    /// The keyboard's length meter; also used by the Action Button / Back Tap shortcut.
    var replyLength: ReplyLength {
        get { ReplyLength(rawValue: defaults.string(forKey: "replyLength") ?? "") ?? .auto }
        set { defaults.set(newValue.rawValue, forKey: "replyLength") }
    }

    var isConfigured: Bool { !serverURL.isEmpty && !appToken.isEmpty }

    /// Free (Apple Intelligence on the phone) or Premium (Claude). Shared with the keyboard and Shortcut.
    var engine: Engine {
        get { Engine(rawValue: defaults.string(forKey: "engine") ?? "") ?? .premium }
        set { defaults.set(newValue.rawValue, forKey: "engine") }
    }

    // MARK: Latest suggestions

    var latestBatch: SuggestionBatch? {
        get { decode(SuggestionBatch.self, key: "latestBatch") }
        set { encode(newValue, key: "latestBatch") }
    }

    /// Local copy of your persona, so the app opens instantly. The server's copy is what replies use.
    var persona: Persona {
        get { decode(Persona.self, key: "persona") ?? .default }
        set { encode(newValue, key: "persona") }
    }

    var pendingInsert: PendingInsert? {
        get { decode(PendingInsert.self, key: "pendingInsert") }
        set { encode(newValue, key: "pendingInsert") }
    }

    // MARK: Last screenshot (compressed JPEG), for "regenerate" from the keyboard

    private var screenshotURL: URL? { containerURL?.appendingPathComponent("last-screenshot.jpg") }

    func saveScreenshot(_ jpeg: Data?) {
        guard let url = screenshotURL else { return }
        if let jpeg { try? jpeg.write(to: url, options: .atomic) } else { try? FileManager.default.removeItem(at: url) }
    }

    func loadScreenshot() -> Data? {
        guard let url = screenshotURL else { return nil }
        return try? Data(contentsOf: url)
    }

    // MARK: Helpers

    private func decode<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func encode<T: Encodable>(_ value: T?, key: String) {
        if let value, let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
