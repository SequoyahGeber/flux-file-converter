import XCTest
import SharedStrings
import SharedTestSupport

/// Flux's Mac UI tests (FX-A-14/B-20; PLAN §4.11 shared flows, D-086, D-105), on SharedKit's shared flows with fast
/// reuse (D-083): one launch, then an in-place reset between tests. They drive "Flux UITests.app"
/// (`scripts/mac-uitest.sh`), a sandboxed Debug build with its own bundle id, so `-resetData` never reaches the
/// installed Flux's settings, and Save All writes only into a folder inside that app's own container.
@MainActor
final class FluxMacUITests: XCTestCase {
    static let bundleID = "com.sequoyah.flux.mac.uitest"
    /// `.test-output/mac-uitests/Flux UITests.app` in this repository; `FLUX_MAC_UITEST_APP` overrides it.
    static var appURL: URL {
        if let path = ProcessInfo.processInfo.environment["FLUX_MAC_UITEST_APP"] { return URL(fileURLWithPath: path) }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return root.appending(path: ".test-output/mac-uitests/Flux UITests.app")
    }

    private var app: XCUIApplication!

    /// D-134: the app stays up between tests (D-083), and its in-place reset closes Settings, the shortcuts window and
    /// sheets. After the last test it quits, so nothing is left on the owner's screen; scripts/mac-uitest.sh also quits
    /// it on failure or timeout.
    nonisolated override class func tearDown() {
        MainActor.assumeIsolated { XCUIApplication(bundleIdentifier: bundleID).terminate() }
        super.tearDown()
    }

    private func start(_ flags: [String] = [], waitForPage: Bool = true) {
        continueAfterFailure = false
        app = XCUIApplication(url: Self.appURL)
        UITestAppReuse.launchOrReset(app, bundleID: Self.bundleID, flags: ["-uiTesting"] + flags)
        app.activate()  // a system panel from another app can hold the keyboard
        if waitForPage {
            XCTAssertTrue(SharedUIFlows.appears(page.staticTexts["A NEW FORMAT, IN A MOMENT"], within: 20),
                          "The converter page did not load")
        }
    }

    private var page: XCUIElement { app.webViews.firstMatch }
    private func menuItem(_ menu: String, _ title: String) -> XCUIElement { app.menuBars.menuBarItems[menu].menuItems[title] }
    private func becomes(_ element: XCUIElement, _ format: String, within timeout: TimeInterval = 10) -> Bool {
        XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)], timeout: timeout) == .completed
    }

    func testHelpMenuHasTheStandardItems() {
        start()
        SharedUIFlows.assertHelpMenu(in: app, appName: "Flux", hasOnboarding: false)
    }

    func testKeyboardShortcutsListEveryMenuShortcut() {
        start()
        app.menuBars.menuBarItems["Help"].click()
        menuItem("Help", "Keyboard Shortcuts").click()
        XCTAssertTrue(SharedUIFlows.appears(app.descendants(matching: .any)[SharedAccessibilityID.Shortcuts.window], within: SharedUIFlows.timeout))
        for shortcut in ["⌥⌘/", "⌘F", "⌘K", "⌘↩"] {
            XCTAssertTrue(app.staticTexts[shortcut].exists, "The shortcuts window lists \(shortcut)")
        }
    }

    func testSettingsHasTheStandardSectionsAndVersion() {
        start()
        app.typeKey(",", modifierFlags: .command)
        XCTAssertTrue(SharedUIFlows.appears(app.staticTexts["Output folder"].firstMatch, within: SharedUIFlows.timeout), "Settings did not open on ⌘,")
        SharedUIFlows.assertSettingsSections(in: app, appSections: ["Output folder", "Appearance", "Diagnostics"])
        SharedUIFlows.assertAboutShowsVersion(in: app)
    }

    func testFeedbackFromTheHelpMenu() {
        start()
        SharedUIFlows.sendFeedback(in: app) { SharedUIFlows.openFeedbackFromHelpMenu(app) }
    }

    /// FX-B-12: with nothing queued, Start and Cancel are dimmed, so the shortcut can't silently do nothing.
    func testStartAndCancelAreDimmedWithNothingToDo() {
        start()
        let startItem = menuItem("File", "Start Conversion, Compression or Archive")
        XCTAssertTrue(becomes(startItem, "enabled == false"), "Start is dimmed with an empty queue")
        XCTAssertFalse(menuItem("File", "Cancel Batch").isEnabled, "Cancel is dimmed with no batch running")
        XCTAssertTrue(menuItem("Go", "All Formats").isEnabled, "Go items work while nothing runs")
    }

    /// FX-B-12: Edit ▸ Search Formats… (⌘F) opens All Formats.
    func testSearchFormatsShortcutOpensTheFormatList() {
        start()
        app.typeKey("f", modifierFlags: .command)
        XCTAssertTrue(SharedUIFlows.appears(page.staticTexts["A world of formats"].firstMatch, within: SharedUIFlows.timeout),
                      "⌘F opens All Formats")
    }

    /// FX-B-12 and FX-B-11: the sample converts from ⌘↩, Start dims once nothing is left, and Save all saves the result
    /// into the test folder (the stand-in for a Settings folder) without a panel.
    func testConvertWithTheMenuThenSaveAll() {
        start(["-demo"])
        let startItem = menuItem("File", "Start Conversion, Compression or Archive")
        XCTAssertTrue(becomes(startItem, "enabled == true"), "Start is available with the sample queued")
        app.typeKey(.return, modifierFlags: .command)
        let saveAs = page.buttons["Save as…"].firstMatch
        XCTAssertTrue(saveAs.waitForExistence(timeout: 60), "The sample converted")
        XCTAssertTrue(becomes(startItem, "enabled == false"), "Start dims once nothing is left to start")
        let saveAll = page.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Save all'")).firstMatch
        XCTAssertTrue(saveAll.waitForExistence(timeout: 10), "Save all is offered for the unsaved result")
        XCTAssertEqual(saveAll.label, "Save all to “Flux UI test saves”")
        saveAll.click()
        let toast = page.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Saved 1 file to'")).firstMatch
        XCTAssertTrue(toast.waitForExistence(timeout: 20), "Save all reports what it saved")
        XCTAssertTrue(page.buttons["Show in Finder"].firstMatch.waitForExistence(timeout: 10), "The result is marked saved")
        XCTAssertFalse(saveAll.exists, "Nothing is left to save")
        XCTAssertTrue(page.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Share '")).firstMatch.exists, "Each result has a Share button")
    }

    /// FX-B-22: when the page can't load, the alert keeps a way forward: feedback brings the alert back when the form
    /// closes, and Try again loads the page.
    func testLaunchFailureOffersFeedbackThenTryAgain() {
        start(["-simulateLaunchFailure"], waitForPage: false)
        let alert = app.dialogs.matching(NSPredicate(format: "label == 'Flux could not start' OR title == 'Flux could not start'")).firstMatch
        let tryAgain = app.buttons["Try again"].firstMatch
        XCTAssertTrue(tryAgain.waitForExistence(timeout: 20), "The launch-failure alert appears: \(alert.debugDescription)")
        XCTAssertTrue(app.buttons["Quit Flux"].exists)
        app.buttons["Send Feedback…"].firstMatch.click()
        let close = app.descendants(matching: .any)[SharedAccessibilityID.Feedback.close]
        XCTAssertTrue(close.waitForExistence(timeout: SharedUIFlows.timeout), "The feedback form opens")
        close.click()
        XCTAssertTrue(tryAgain.waitForExistence(timeout: 10), "The alert comes back after the form closes")
        tryAgain.click()
        XCTAssertTrue(SharedUIFlows.appears(page.staticTexts["A NEW FORMAT, IN A MOMENT"], within: 20), "Try again loads the page")
    }
}
