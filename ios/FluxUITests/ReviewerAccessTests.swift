import XCTest
import SharedStrings
import SharedTestSupport

/// SharedKit's UI-test helpers are main-actor isolated.
@MainActor
final class ReviewerAccessTests: XCTestCase {
    static let bundleID = "com.sequoyah.flux.mac"
    let app = XCUIApplication()

    /// D-134: quit the app once the class is done (tests reuse it in between, D-083), pass or fail.
    nonisolated override class func tearDown() {
        MainActor.assumeIsolated { XCUIApplication().terminate() }
        super.tearDown()
    }

    /// Reuses the running app with an in-place reset when the previous test passed (D-083), else launches it.
    func start() {
        continueAfterFailure = false
        UITestAppReuse.launchOrReset(app, bundleID: Self.bundleID)
        XCTAssertTrue(SharedUIFlows.appears(app.navigationBars["Flux"], within: 15), "Converter on screen")
    }

    func openSettings() {
        let settings = app.buttons[AccessibilityID.Settings.open]
        XCTAssertTrue(SharedUIFlows.appears(settings, within: 10))
        // A system toolbar button: iOS sizes it (36 pt glass button) and ignores the label's 44 pt frame.
        XCTAssertTrue(settings.isHittable, "Settings button can be tapped")
        settings.tap()
    }

    func testSettingsHaveTheStandardSectionsVersionAndOfflinePolicy() {
        start()
        openSettings()
        SharedUIFlows.assertSettingsSections(in: app, appSections: ["Appearance", "Diagnostics"])
        SharedUIFlows.assertAboutShowsVersion(in: app)
        app.buttons[SharedAccessibilityID.Settings.privacyPolicy].tap()
        let policy = app.staticTexts[AccessibilityID.Privacy.text]
        XCTAssertTrue(SharedUIFlows.appears(policy, within: 10))
        XCTAssertTrue(policy.label.contains("collect no personal information"))
        XCTAssertTrue(app.descendants(matching: .any)[SharedAccessibilityID.Privacy.updated].exists, "Updated line")
        // The main screen's bar stays in the tree under the sheet: go back from the policy's own bar.
        app.navigationBars["Privacy policy"].buttons["BackButton"].tap()
        let done = app.buttons[AccessibilityID.Settings.done]
        XCTAssertTrue(SharedUIFlows.appears(done, within: 10)); done.tap()
    }

    /// The stand-in inbox exists only in Debug (D-116: a Release build ignores launch flags), so Release runs skip the
    /// feedback tests; the Release gate for feedback is a send from the TestFlight build (D-119).
    func requireStandIn() throws {
        #if !DEBUG
        throw XCTSkip("Release build: feedback has no stand-in inbox (D-116); the TestFlight send is the gate (D-119)")
        #endif
    }

    func testFeedbackFromTheConverterButtonReachesTheStandInInbox() throws {
        try requireStandIn()
        start()
        continueAfterFailure = true
        SharedUIFlows.sendFeedback(in: app) { SharedUIFlows.openFeedbackFromButton(app) }
        keepScreenOnFailure("feedback-button")
    }

    func testFeedbackFromSettingsReachesTheStandInInbox() throws {
        try requireStandIn()
        start()
        continueAfterFailure = true
        SharedUIFlows.sendFeedback(in: app) { SharedUIFlows.openFeedbackFromSettings(app) { openSettings() } }
        keepScreenOnFailure("feedback-settings")
    }

    /// Diagnostics only on failure (D-083): the attachment is deleted when the test passes.
    func keepScreenOnFailure(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .deleteOnSuccess; add(shot)
    }

    /// Release gate (Phase 5): the system accessibility audit on the converter and on Settings. SharedKit 0.4.3 applies
    /// the system-bar contrast scope itself (D-115, D-128); every other issue fails.
    private func audit() throws {
        try SharedUIFlows.accessibilityAudit(of: app)
    }

    /// The Settings sheet's system-styled rows and bar button: on the iOS 27 simulator the audit cannot resize system
    /// text, and flagged a different one of these per run (Privacy policy, Acknowledgements, Done) with "Dynamic Type
    /// font sizes are partially unsupported". SharedKit's named workaround ignores only `.dynamicType`/`.textClipped`
    /// on exactly these; every other issue, and all of Flux's own text, stays strict.
    private func auditSettings() throws {
        let reason = "system-styled Settings row the iOS 27 simulator cannot resize"
        try SharedUIFlows.accessibilityAudit(of: app, systemStyled: [
            .init(AccessibilityID.Settings.done, reason: "system bar button; long press shows the large content viewer"),
            .init("Recent log", reason: reason), .init("Support", reason: reason), .init("Send feedback", reason: reason),
            .init("Version", reason: reason), .init("Acknowledgements", reason: reason), .init("Privacy policy", reason: reason),
        ])
    }

    func testAccessibilityAudit() throws {
        continueAfterFailure = true  // report every audit issue in one run, not only the first
        start()
        try audit()
        // FX-B-06: also the result card with its success text, after converting the sample image.
        app.buttons[AccessibilityID.Converter.trySample].firstMatch.tap()
        app.buttons[AccessibilityID.Converter.sample("image")].firstMatch.tap()
        let convert = app.buttons[AccessibilityID.Converter.convert].firstMatch
        XCTAssertTrue(SharedUIFlows.appears(convert, within: 10))
        if !convert.isHittable { app.scrollViews[AccessibilityID.Converter.workspace].swipeUp() }
        convert.tap()
        XCTAssertTrue(app.buttons[AccessibilityID.Converter.save].waitForExistence(timeout: 60))
        try audit()
        app.scrollViews[AccessibilityID.Converter.workspace].swipeDown()
        openSettings()
        let done = app.buttons[AccessibilityID.Settings.done]
        XCTAssertTrue(SharedUIFlows.appears(done, within: 10))
        // Audit the settled sheet: mid-presentation, the dimmed Done button measures as low contrast.
        var frame = CGRect.null
        SharedUIFlows.waitUntil(5) {
            let now = done.frame; defer { frame = now }
            return done.isHittable && now == frame
        }
        RunLoop.current.run(until: Date().addingTimeInterval(1))  // the dimming fades after the frame stops
        try auditSettings()
    }

    func testReviewerCanConvertSamplesAndReachSystemSaveWithoutLogin() {
        start()
        let workspace = app.scrollViews[AccessibilityID.Converter.workspace]
        func reveal(_ element: XCUIElement, _ name: String) {
            XCTAssertTrue(element.waitForExistence(timeout: 10), name)
            for _ in 0..<4 {
                if element.isHittable && element.frame.midY < app.frame.maxY - 100 { break }
                workspace.swipeUp()
            }
            XCTAssertTrue(element.isHittable, name)
        }
        func button(_ id: String) -> XCUIElement {
            let element = app.buttons[id].firstMatch
            reveal(element, id)
            return element
        }
        func tap(_ id: String) { button(id).tap() }
        func dismissSavePicker() {
            // Only call this after the system Files picker has appeared, while
            // conversion is idle, so Cancel cannot match the app's busy action.
            if app.buttons["Cancel"].exists {
                app.buttons["Cancel"].firstMatch.tap()
            } else {
                let handle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08))
                handle.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
            }
            let available = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: app.buttons[AccessibilityID.Converter.save])
            XCTAssertEqual(XCTWaiter.wait(for: [available], timeout: 10), .completed, "Cancelled export stays available")
        }
        workspace.swipeDown()
        for sample in ["image", "document", "video", "data", "archive"] {
            workspace.swipeDown()
            tap(AccessibilityID.Converter.trySample); tap(AccessibilityID.Converter.sample(sample))
            let format = button(AccessibilityID.Converter.outputFormat)
            XCTAssertTrue(format.label.contains("Convert to"), "Output picker keeps its spoken purpose")
            if sample == "archive" {
                // The bundled archive sample selects the real unzip target.
                // iOS 27 reports the menu picker's selection in its label or its value.
                let shown = [format.label, format.value as? String ?? ""].joined(separator: " ")
                XCTAssertTrue(shown.contains("Extract archive"), "Archive selects Extract archive: \(shown)")
            }
            let outputName = app.descendants(matching: .any)[AccessibilityID.Converter.outputName].firstMatch  // a wrapping field may report as a text view
            reveal(outputName, AccessibilityID.Converter.outputName)
            XCTAssertEqual(outputName.label, sample == "archive" ? "Folder name" : "Output file name")
            // The visible captions are hidden from VoiceOver to avoid duplicate
            // names. Keep an attachment for reviewing the Convert to caption.
            let configuration = XCTAttachment(screenshot: app.screenshot())
            configuration.name = "review-configuration-" + sample; configuration.lifetime = .keepAlways; add(configuration)
            let convert = button(AccessibilityID.Converter.convert)
            XCTAssertEqual(convert.label, "Convert")
            convert.tap()
            XCTAssertTrue(app.buttons[AccessibilityID.Converter.save].waitForExistence(timeout: 60), sample)
            XCTAssertEqual(app.buttons[AccessibilityID.Converter.save].label, "Save as…")
            // FX-B-05: the result scrolls into view by itself; no swiping before this check.
            let save = app.buttons[AccessibilityID.Converter.save]
            let onScreen = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: save)
            XCTAssertEqual(XCTWaiter.wait(for: [onScreen], timeout: 5), .completed, "Save is on screen after converting: " + sample)
            XCTAssertLessThan(save.frame.maxY, app.frame.maxY, "Save is inside the screen after converting: " + sample)
            let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = "review-" + sample; capture.lifetime = .keepAlways; add(capture)
            if sample == "image" || sample == "archive" {
                tap(AccessibilityID.Converter.save)
                XCTAssertTrue(app.buttons["DOCPicker.actionButton"].waitForExistence(timeout: 30), "System Files save picker: " + sample)
                let picker = XCTAttachment(screenshot: app.screenshot()); picker.name = "review-system-save-" + sample; picker.lifetime = .keepAlways; add(picker)
                dismissSavePicker()
                tap(AccessibilityID.Converter.save)
                XCTAssertTrue(app.buttons["DOCPicker.actionButton"].waitForExistence(timeout: 10), "Save can be retried: " + sample)
                dismissSavePicker()
            }
            let clear = button(AccessibilityID.Converter.clear)
            XCTAssertGreaterThanOrEqual(clear.frame.height, 44, "Clear touch height: " + sample)
            clear.tap()
            // The result was never saved, so clearing asks before deleting it.
            // iOS 27 shows the dialog as a popover whose button nests a second element with the same id.
            let confirm = app.buttons[AccessibilityID.Converter.clearConfirm].firstMatch
            XCTAssertTrue(confirm.waitForExistence(timeout: 10), "Clear asks before deleting an unsaved result: " + sample)
            confirm.tap()
            XCTAssertTrue(app.buttons[AccessibilityID.Converter.trySample].waitForExistence(timeout: 10), "Cleared job")
        }
        XCTAssertFalse(app.staticTexts["Sign in"].exists)
    }
}
