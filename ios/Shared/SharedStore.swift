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

    // MARK: Settings

    var serverURL: String {
        get { defaults.string(forKey: "serverURL") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "serverURL") }
    }

    var appToken: String {
        get { defaults.string(forKey: "appToken") ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "appToken") }
    }

    var aboutMe: String {
        get { defaults.string(forKey: "aboutMe") ?? "" }
        set { defaults.set(newValue, forKey: "aboutMe") }
    }

    var styleExamples: String {
        get { defaults.string(forKey: "styleExamples") ?? "" }
        set { defaults.set(newValue, forKey: "styleExamples") }
    }

    var tone: Tone {
        get { Tone(rawValue: defaults.string(forKey: "tone") ?? "") ?? .witty }
        set { defaults.set(newValue.rawValue, forKey: "tone") }
    }

    var isConfigured: Bool { !serverURL.isEmpty && !appToken.isEmpty }

    // MARK: Latest suggestions

    var latestBatch: SuggestionBatch? {
        get {
            guard let data = defaults.data(forKey: "latestBatch") else { return nil }
            return try? JSONDecoder().decode(SuggestionBatch.self, from: data)
        }
        set {
            defaults.set(try? JSONEncoder().encode(newValue), forKey: "latestBatch")
        }
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
}
