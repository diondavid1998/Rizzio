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

    // MARK: Profile screens

    /// Back Tap screenshots taken a few minutes apart are usually the same profile, scrolled. Keeping the last few
    /// lets Rizzio read the whole person (name, job, every prompt and photo), not just what's on screen now.
    private var profileScreensDir: URL? { containerURL?.appendingPathComponent("profile-screens", isDirectory: true) }

    /// Screenshots of the current profile, oldest first, each within `maxAge` seconds of the next.
    /// `fromNow`: the newest must also be recent (a new Back Tap); false measures from the newest screen (rewrites).
    func profileScreens(maxAge: TimeInterval = 180, fromNow: Bool = true) -> [Data] {
        guard let dir = profileScreensDir,
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return [] }
        let dated = files.compactMap { url -> (URL, Date)? in
            guard let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { return nil }
            return (url, date)
        }.sorted { $0.1 < $1.1 }
        // Walk back from the newest: stop at the first gap longer than maxAge (a different profile).
        var kept: [(URL, Date)] = []
        var newer = fromNow ? Date() : (dated.last?.1 ?? Date())
        for item in dated.reversed() {
            guard newer.timeIntervalSince(item.1) <= maxAge else { break }
            kept.insert(item, at: 0)
            newer = item.1
        }
        return kept.suffix(4).compactMap { try? Data(contentsOf: $0.0) }
    }

    /// Remembers a screenshot as part of the current profile (keeps the last 4).
    func addProfileScreen(_ jpeg: Data) {
        guard let dir = profileScreensDir else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? jpeg.write(to: dir.appendingPathComponent("\(Int(Date().timeIntervalSince1970 * 1000)).jpg"), options: .atomic)
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for old in files.dropLast(4) { try? FileManager.default.removeItem(at: old) }
    }

    /// Starts fresh, e.g. when the user moves on to a different profile.
    func clearProfileScreens() {
        if let dir = profileScreensDir { try? FileManager.default.removeItem(at: dir) }
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
