import XCTest

/// Taps through every screen of Rizzio against a local test server (backend with RIZZIO_FAKE_AI=1).
/// CI starts the server on port 4000 before running these. Each test uses a fresh user.
final class RizzioUITests: XCTestCase {
    static let server = ProcessInfo.processInfo.environment["RIZZIO_UITEST_SERVER"] ?? "http://127.0.0.1:4000"
    static let token = "uitest-token"

    var app: XCUIApplication!
    var userId = ""

    override func setUp() {
        continueAfterFailure = false
        userId = "uitest-\(UUID().uuidString)"
        app = XCUIApplication()
        app.launchEnvironment = [
            "RIZZIO_UITEST_SERVER": Self.server,
            "RIZZIO_UITEST_TOKEN": Self.token,
            "RIZZIO_UITEST_USER": userId,
        ]
        app.launch()
    }

    // MARK: Helpers

    func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    func text(containing s: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    func anyText(containing s: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    /// Scrolls the current list until the element can be tapped.
    @discardableResult
    func reveal(_ el: XCUIElement, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        var tries = 0
        while !(el.exists && el.isHittable) && tries < 12 {
            app.swipeUp()
            tries += 1
        }
        if !el.isHittable {
            tries = 0
            while !(el.exists && el.isHittable) && tries < 12 {
                app.swipeDown()
                tries += 1
            }
        }
        XCTAssertTrue(el.exists && el.isHittable, "Couldn't find \(el)", file: file, line: line)
        return el
    }

    func tab(_ name: String) {
        app.tabBars.buttons[name].tap()
    }

    func waitFor(_ el: XCUIElement, _ seconds: TimeInterval = 20, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(el.waitForExistence(timeout: seconds), "Never appeared: \(el)", file: file, line: line)
    }

    func assertNoConnectionErrors() {
        XCTAssertFalse(text(containing: "Network problem").exists, "Connection error shown")
        XCTAssertFalse(text(containing: "Unauthorized").exists, "Token rejected")
        XCTAssertFalse(text(containing: "Open Rizzio → Setup").exists, "App thinks it isn't configured")
    }

    /// Creates a saved suggestion for this user, like the Action Button would.
    func seedGeneration() throws {
        var req = URLRequest(url: URL(string: Self.server + "/v1/replies")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(Self.token)", forHTTPHeaderField: "Authorization")
        req.setValue(userId, forHTTPHeaderField: "X-Rizzio-User")
        req.httpBody = #"{"mode":"auto","text":"Prompt: Typical Sunday"}"#.data(using: .utf8)
        let done = expectation(description: "seed")
        var status = 0
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        XCTAssertEqual(status, 200, "Couldn't seed a suggestion on the test server")
    }

    // MARK: Tests

    func test1_SetupSavesServer() {
        tab("Setup")
        XCTAssertEqual(element("serverURL").value as? String, Self.server)
        reveal(app.buttons["Save"]).tap()
        waitFor(app.buttons["Saved ✓"], 5)
        // Setup guide sections are all there.
        reveal(text(containing: "Turn on the keyboard"))
        reveal(text(containing: "Make the Shortcut"))
        reveal(text(containing: "Put it on a button"))
    }

    func test2_PersonaPresetsTogglesAndSave() {
        tab("Persona")
        waitFor(text(containing: "Your vibe"))
        assertNoConnectionErrors()
        let save = app.navigationBars.buttons["Save"]
        XCTAssertFalse(save.isEnabled, "Save should be off before any change")

        // Every preset applies.
        for preset in ["😎 Smooth", "🐶 Golden retriever", "🍸 Dry wit", "🌹 Hopeless romantic", "🌀 Chaos", "🧊 Chill"] {
            let button = app.buttons[preset]
            if !button.isHittable { app.scrollViews.firstMatch.swipeLeft() }
            waitFor(button, 5)
            button.tap()
        }
        XCTAssertTrue(save.isEnabled, "A preset should make Save available")

        // Sliders move.
        let flirty = app.sliders.firstMatch
        reveal(flirty).adjust(toNormalizedSliderPosition: 0.9)

        // Toggles flip.
        let lowercase = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'all lowercase'")).firstMatch
        reveal(lowercase)
        let before = lowercase.value as? String
        lowercase.tap()
        XCTAssertNotEqual(lowercase.value as? String, before)

        // Never-mention text.
        let avoid = reveal(element("avoid"))
        avoid.tap()
        avoid.typeText("politics")

        save.tap()
        let saved = NSPredicate(format: "isEnabled == false")
        expectation(for: saved, evaluatedWith: save)
        waitForExpectations(timeout: 15)
        assertNoConnectionErrors()

        // Reset to defaults makes it editable again.
        reveal(app.buttons["Reset to defaults"]).tap()
        XCTAssertTrue(save.isEnabled)
    }

    func test3_TestDriveSampleAndCustom() {
        tab("Persona")
        waitFor(text(containing: "Your vibe"))
        // Turn on lowercase (unsaved) so we can see Test drive uses current settings.
        let lowercase = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'all lowercase'")).firstMatch
        reveal(lowercase)
        if (lowercase.value as? String) == "0" { lowercase.tap() }

        reveal(app.buttons["Test drive these settings"]).tap()
        app.buttons.matching(identifier: "Write replies").firstMatch.tap()
        waitFor(text(containing: "fake reply 1 lol"))
        XCTAssertTrue(text(containing: "fake reply 5 lol").exists)

        // Tap a reply to copy it.
        text(containing: "fake reply 2 lol").tap()
        waitFor(text(containing: "Copied"), 3)

        // Custom prompt.
        let custom = reveal(element("customPrompt"))
        custom.tap()
        custom.typeText("Prompt: I'm weirdly good at\nAnswer: parallel parking")
        reveal(app.buttons.matching(identifier: "Write replies").element(boundBy: 1)).tap()
        waitFor(text(containing: "fake reply 1 lol"))
        assertNoConnectionErrors()
    }

    func test4_AutoTuneLearnsFromPastedTextsAndApplies() {
        tab("Persona")
        waitFor(text(containing: "Your vibe"))
        reveal(app.buttons["Auto-tune from my texts"]).tap()

        // Nothing learned yet: explains instead of failing silently.
        waitFor(text(containing: "Upload some of your chats"))

        let paste = element("autotunePaste")
        waitFor(paste)
        paste.tap()
        paste.typeText("lmao no\nok but tacos tho")
        app.buttons["Add these messages"].tap()
        waitFor(text(containing: "Added 2 messages"))
        waitFor(text(containing: "never uses emoji"))

        app.buttons["Apply these"].tap()
        let save = app.navigationBars.buttons["Save"]
        waitFor(save)
        XCTAssertTrue(save.isEnabled, "Applying auto-tune should change the sliders")
        save.tap()
        expectation(for: NSPredicate(format: "isEnabled == false"), evaluatedWith: save)
        waitForExpectations(timeout: 15)
    }

    func test5_TrainSaveRelearnAndForget() {
        tab("Train")
        waitFor(text(containing: "Style match"))
        assertNoConnectionErrors()

        let examples = reveal(element("examples"))
        examples.tap()
        examples.typeText("bet\nnah ur wild for that")
        reveal(app.buttons["Save messages"]).tap()
        waitFor(anyText(containing: "Saved 2 messages"))

        let about = reveal(element("aboutMe"))
        about.tap()
        about.typeText("27, NYC, climbing")
        reveal(app.buttons["Save"]).tap()
        waitFor(anyText(containing: "Rizzio updated your texting style"))

        reveal(app.buttons["Re-learn now"]).tap()
        waitFor(anyText(containing: "Updated how Rizzio thinks you text"))
        reveal(text(containing: "test profile built from"))

        reveal(app.buttons["Forget everything learned"]).tap()
        app.buttons["Forget"].firstMatch.tap()
        waitFor(anyText(containing: "Rizzio forgot what it learned"))
    }

    func test6_HistoryMarkAMatch() throws {
        try seedGeneration()
        tab("History")
        let row = text(containing: "Prompt: Typical Sunday")
        waitFor(row)
        row.tap()

        reveal(text(containing: "Fake reply 2")).tap()
        reveal(element("sentText"))
        reveal(app.buttons["💘 Match"]).tap()
        reveal(app.buttons["Save"]).tap()
        waitFor(app.buttons["Saved ✓"], 10)

        // Back in the list, it shows the match.
        app.navigationBars.buttons.firstMatch.tap()
        waitFor(anyText(containing: "💘"))
    }

    func test7_AllTabsLoadWithoutErrors() {
        for name in ["Persona", "Train", "History", "Setup"] {
            tab(name)
            sleep(2)
            assertNoConnectionErrors()
        }
    }
}
