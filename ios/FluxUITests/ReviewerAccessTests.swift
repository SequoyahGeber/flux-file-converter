import XCTest
import SharedStrings
import SharedTestSupport

/// SharedKit's UI-test helpers are main-actor isolated.
@MainActor
final class ReviewerAccessTests: XCTestCase {
    static let bundleID = "com.sequoyah.flux.mac"
    let app = XCUIApplication()

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

    func testFeedbackFromTheConverterButtonReachesTheStandInInbox() {
        start()
        continueAfterFailure = true
        // D-119: SharedKit 0.4.1's iOS flow leaves the keyboard over "Review report" and races vanishing cells.
        XCTExpectFailure("SharedKit 0.4.2 SharedUIFlows iOS feedback-flow fix (D-119)", strict: false)
        SharedUIFlows.sendFeedback(in: app) { SharedUIFlows.openFeedbackFromButton(app) }
        keepScreenOnFailure("feedback-button")
    }

    func testFeedbackFromSettingsReachesTheStandInInbox() {
        start()
        continueAfterFailure = true
        // D-119: SharedKit 0.4.1's iOS flow leaves the keyboard over "Review report" and races vanishing cells.
        XCTExpectFailure("SharedKit 0.4.2 SharedUIFlows iOS feedback-flow fix (D-119)", strict: false)
        SharedUIFlows.sendFeedback(in: app) { SharedUIFlows.openFeedbackFromSettings(app) { openSettings() } }
        keepScreenOnFailure("feedback-settings")
    }

    /// Diagnostics only on failure (D-083): the attachment is deleted when the test passes.
    func keepScreenOnFailure(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .deleteOnSuccess; add(shot)
    }

    /// Release gate (Phase 5): the system accessibility audit on the converter and on Settings.
    func testAccessibilityAudit() throws {
        start()
        try SharedUIFlows.accessibilityAudit(of: app)
        // FX-B-06: also the result card with its success text, after converting the sample image.
        app.buttons[AccessibilityID.Converter.trySample].firstMatch.tap()
        app.buttons[AccessibilityID.Converter.sample("image")].firstMatch.tap()
        let convert = app.buttons[AccessibilityID.Converter.convert].firstMatch
        XCTAssertTrue(SharedUIFlows.appears(convert, within: 10))
        if !convert.isHittable { app.scrollViews[AccessibilityID.Converter.workspace].swipeUp() }
        convert.tap()
        XCTAssertTrue(app.buttons[AccessibilityID.Converter.save].waitForExistence(timeout: 60))
        try SharedUIFlows.accessibilityAudit(of: app)
        app.scrollViews[AccessibilityID.Converter.workspace].swipeDown()
        openSettings()
        XCTAssertTrue(SharedUIFlows.appears(app.buttons[AccessibilityID.Settings.done], within: 10))
        try SharedUIFlows.accessibilityAudit(of: app)
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
