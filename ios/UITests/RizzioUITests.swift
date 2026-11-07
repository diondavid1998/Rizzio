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

    /// Short, slow drags so the list can't fly past the element.
    func nudge(up: Bool) {
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        let bottom = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
        (up ? bottom : top).press(forDuration: 0.05, thenDragTo: up ? top : bottom)
    }

    /// Scrolls the current list until the element can be tapped:
    /// jump to the top first, then move down in small steps so nothing gets skipped.
    @discardableResult
    func reveal(_ el: XCUIElement, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        dismissKeyboard()
        if el.exists && el.isHittable { return el }
        for _ in 0..<6 { app.swipeDown(velocity: .fast) }
        var tries = 0
        while !(el.exists && el.isHittable) && tries < 45 {
            nudge(up: true)
            tries += 1
        }
        XCTAssertTrue(el.exists && el.isHittable, "Couldn't find \(el)", file: file, line: line)
        return el
    }

    func dismissKeyboard() {
        let done = app.buttons["keyboardDone"]
        if app.keyboards.count > 0, done.exists { done.tap() }
    }

    /// Flips a switch by tapping the switch itself (tapping its label does nothing on iOS).
    func flip(_ toggle: XCUIElement) {
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    }

    func lowercaseSwitch() -> XCUIElement { element("toggle.lowercase") }

    /// Saves a screenshot for the QA report (and attaches it to the test result).
    func snap(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let dir = ProcessInfo.processInfo.environment["RIZZIO_SNAP_DIR"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
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
        snap("01-setup")
        // Setup guide sections are all there.
        reveal(text(containing: "Turn on the keyboard"))
        reveal(text(containing: "Make the Shortcut"))
        reveal(text(containing: "Put it on a button"))
    }

    func test2_PersonaPresetsTogglesAndSave() {
        tab("Persona")
        waitFor(text(containing: "YOUR STYLE"))
        assertNoConnectionErrors()
        snap("02-persona")
        let save = app.navigationBars.buttons["Save"]
        XCTAssertFalse(save.isEnabled, "Save should be off before any change")

        // Every preset applies.
        for preset in ["Smooth", "Golden retriever", "Dry wit", "Hopeless romantic", "Chaos", "Chill"] {
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
        let lowercase = lowercaseSwitch()
        reveal(lowercase)
        let before = lowercase.value as? String
        flip(lowercase)
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

    /// Saves a persona with "all lowercase" on, straight to the server (the switch itself is tested in test2).
    func saveLowercasePersona() {
        var req = URLRequest(url: URL(string: Self.server + "/v1/me/persona")!)
        req.httpMethod = "PUT"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(Self.token)", forHTTPHeaderField: "Authorization")
        req.setValue(userId, forHTTPHeaderField: "X-Rizzio-User")
        req.httpBody = #"{"persona":{"toggles":{"lowercase":true}}}"#.data(using: .utf8)
        let done = expectation(description: "persona")
        URLSession.shared.dataTask(with: req) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 15)
    }

    /// Test drive writes replies from a sample and from your own text.
    /// (That unsaved slider changes reach Test drive is covered by the live server QA.)
    func test3_TestDriveSampleAndCustom() {
        tab("Persona")
        waitFor(text(containing: "YOUR STYLE"))
        reveal(app.buttons["Test drive these settings"]).tap()
        app.buttons.matching(identifier: "Write replies").firstMatch.tap()
        waitFor(text(containing: "Fake reply 1"))
        snap("03-test-drive")
        reveal(text(containing: "Fake reply 5")) // all 5 replies are there (5th is below the fold)

        // Tap a reply to copy it.
        reveal(text(containing: "Fake reply 2")).tap()
        waitFor(anyText(containing: "Copied"), 3)

        // Custom prompt.
        let custom = reveal(element("customPrompt"))
        custom.tap()
        custom.typeText("Prompt: I'm weirdly good at\nAnswer: parallel parking")
        reveal(app.buttons.matching(identifier: "Write replies").element(boundBy: 1)).tap()
        waitFor(text(containing: "Fake reply 1"))
        assertNoConnectionErrors()
    }

    func test4_AutoTuneLearnsFromPastedTextsAndApplies() {
        tab("Persona")
        waitFor(text(containing: "YOUR STYLE"))
        reveal(app.buttons["Match how I actually text"]).tap()

        // Nothing learned yet: explains instead of failing silently.
        waitFor(text(containing: "Upload some of your chats"))

        let paste = element("autotunePaste")
        waitFor(paste)
        paste.tap()
        paste.typeText("lmao no\nok but tacos tho")
        app.buttons["Add these messages"].tap()
        waitFor(text(containing: "Added 2 messages"))
        waitFor(text(containing: "never uses emoji"))
        snap("04-auto-tune")

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
        snap("05-train-saved")

        let about = reveal(element("aboutMe"))
        about.tap()
        about.typeText("27, NYC, climbing")
        reveal(app.buttons["Save"]).tap()
        waitFor(anyText(containing: "Rizzio updated your texting style"))

        reveal(app.buttons["Re-learn now"]).tap()
        waitFor(anyText(containing: "Updated how Rizzio thinks you text"))
        reveal(text(containing: "test profile built from"))
        snap("06-train-profile")

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
        snap("07-history-detail")

        // Back in the list, it shows the match.
        app.navigationBars.buttons.firstMatch.tap()
        waitFor(anyText(containing: "💘"))
        snap("08-history")
    }

    func test7_AllTabsLoadWithoutErrors() {
        for name in ["Persona", "Train", "History", "Setup"] {
            tab(name)
            sleep(2)
            assertNoConnectionErrors()
        }
    }

    /// Screenshots of every main screen in light and dark mode, for design review.
    func test8_LightAndDarkScreens() throws {
        try seedGeneration()
        for mode in ["light", "dark"] {
            app.terminate()
            app.launchEnvironment["RIZZIO_UITEST_APPEARANCE"] = mode
            app.launch()

            tab("Persona")
            waitFor(text(containing: "YOUR STYLE"))
            snap("\(mode)-1-persona")
            reveal(app.sliders.firstMatch)
            snap("\(mode)-2-persona-sliders")

            reveal(app.buttons["Test drive these settings"]).tap()
            app.buttons.matching(identifier: "Write replies").firstMatch.tap()
            waitFor(text(containing: "Fake reply 1"))
            snap("\(mode)-3-test-drive")
            app.navigationBars.buttons.firstMatch.tap()

            tab("Train")
            waitFor(text(containing: "Style match"))
            snap("\(mode)-4-train")

            tab("History")
            waitFor(text(containing: "Prompt: Typical Sunday"))
            snap("\(mode)-5-history")

            tab("Setup")
            waitFor(element("serverURL"))
            snap("\(mode)-6-setup")
            assertNoConnectionErrors()
        }
    }
}
