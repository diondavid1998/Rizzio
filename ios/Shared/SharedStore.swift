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

    /// The name read from the top of the last profile screenshot (Hinge shows it while you scroll).
    var lastProfileHeader: String {
        get { defaults.string(forKey: "lastProfileHeader") ?? "" }
        set { defaults.set(newValue, forKey: "lastProfileHeader") }
    }

    /// "Maya, 27" and "maya" match; empty when nothing usable was read.
    static func headerKey(_ header: String) -> String {
        let word = header.lowercased().split(whereSeparator: { !$0.isLetter }).first.map(String.init) ?? ""
        return word.count >= 2 ? word : ""
    }

    /// Screenshots of the current profile, oldest first, each within `maxAge` seconds of the next.
    /// Only screens showing the same name at the top are linked; when a name can't be read either side,
    /// only screens within 90 seconds are, so a different person's profile never gets mixed in.
    /// `fromNow`: the newest must also be recent (a new Back Tap); false measures from the newest screen (rewrites).
    func profileScreens(maxAge: TimeInterval = 180, fromNow: Bool = true, header: String? = nil) -> [Data] {
        guard let dir = profileScreensDir,
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
        else { return [] }
        let want = SharedStore.headerKey(header ?? lastProfileHeader)
        let dated = files.filter { $0.pathExtension == "jpg" }.compactMap { url -> (URL, Date, String)? in
            guard let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { return nil }
            let saved = (try? String(contentsOf: url.deletingPathExtension().appendingPathExtension("txt"), encoding: .utf8)) ?? ""
            return (url, date, SharedStore.headerKey(saved))
        }.sorted { $0.1 < $1.1 }
        // Walk back from the newest: stop at a different name, or at a gap that's too long.
        var kept: [URL] = []
        var newer = fromNow ? Date() : (dated.last?.1 ?? Date())
        for (url, date, key) in dated.reversed() {
            if !want.isEmpty, !key.isEmpty, key != want { break } // someone else's profile
            let limit = (!want.isEmpty && key == want) ? maxAge : min(maxAge, 90)
            guard newer.timeIntervalSince(date) <= limit else { break }
            kept.insert(url, at: 0)
            newer = date
        }
        return kept.suffix(4).compactMap { try? Data(contentsOf: $0) }
    }

    /// Remembers a screenshot as part of the current profile (keeps the last 4), with the name read from its top.
    func addProfileScreen(_ jpeg: Data, header: String = "") {
        guard let dir = profileScreensDir else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stamp = "\(Int(Date().timeIntervalSince1970 * 1000))"
        try? jpeg.write(to: dir.appendingPathComponent("\(stamp).jpg"), options: .atomic)
        try? header.write(to: dir.appendingPathComponent("\(stamp).txt"), atomically: true, encoding: .utf8)
        lastProfileHeader = header
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "jpg" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for old in files.dropLast(4) {
            try? FileManager.default.removeItem(at: old)
            try? FileManager.default.removeItem(at: old.deletingPathExtension().appendingPathExtension("txt"))
        }
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
