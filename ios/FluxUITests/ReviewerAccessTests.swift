import XCTest

final class ReviewerAccessTests: XCTestCase {
    func testReviewerCanReadPolicyConvertSamplesAndReachSystemSaveWithoutLogin() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launchArguments = ["-uiTesting", "-resetData"]; app.launch()
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
        XCTAssertTrue(app.navigationBars["Flux"].waitForExistence(timeout: 10))
        // Settings: gear at the top trailing corner, sheet with Done; the policy reads offline.
        let settings = app.buttons[AccessibilityID.Settings.open]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        // A system toolbar button: iOS sizes it (36 pt glass button) and ignores the label's 44 pt frame.
        XCTAssertTrue(settings.isHittable, "Settings button can be tapped")
        settings.tap()
        XCTAssertTrue(app.descendants(matching: .any)[AccessibilityID.Settings.version].waitForExistence(timeout: 10), "Version row")
        app.buttons[AccessibilityID.Settings.privacyPolicy].tap()
        let policy = app.staticTexts[AccessibilityID.Privacy.text]
        XCTAssertTrue(policy.waitForExistence(timeout: 10))
        XCTAssertTrue(policy.label.contains("collect no personal information"))
        // The main screen's bar stays in the tree under the sheet: go back from the policy's own bar.
        app.navigationBars["Privacy policy"].buttons["BackButton"].tap()
        let done = app.buttons[AccessibilityID.Settings.done]
        XCTAssertTrue(done.waitForExistence(timeout: 10)); done.tap()
        workspace.swipeDown()
        for sample in ["image", "document", "video", "data", "archive"] {
            workspace.swipeDown()
            tap(AccessibilityID.Converter.trySample); tap(AccessibilityID.Converter.sample(sample))
            let format = button(AccessibilityID.Converter.outputFormat)
            XCTAssertTrue(format.label.contains("Convert to"), "Output picker keeps its spoken purpose")
            if sample == "archive" {
                // The bundled archive sample selects the real unzip target.
                XCTAssertEqual(format.value as? String, "Extract archive")
            }
            let outputName = app.textFields[AccessibilityID.Converter.outputName]
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
