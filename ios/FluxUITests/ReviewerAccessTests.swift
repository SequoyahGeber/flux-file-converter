import XCTest

final class ReviewerAccessTests: XCTestCase {
    func testReviewerCanReadPolicyConvertSamplesAndReachSystemSaveWithoutLogin() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        let workspace = app.scrollViews["converter-workspace"]
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
            let available = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: app.buttons["save-output"])
            XCTAssertEqual(XCTWaiter.wait(for: [available], timeout: 10), .completed, "Cancelled export stays available")
        }
        XCTAssertTrue(app.navigationBars["Flux"].waitForExistence(timeout: 10))
        let privacy = button("privacy-support")
        XCTAssertGreaterThanOrEqual(privacy.frame.height, 44, "Privacy & support touch height")
        privacy.tap()
        XCTAssertTrue(app.staticTexts["offline-privacy"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["offline-privacy"].label.contains("collect no personal information"))
        tap("privacy-done")
        workspace.swipeDown()
        for sample in ["image", "document", "video", "data", "archive"] {
            workspace.swipeDown()
            tap("try-sample"); tap("sample-" + sample)
            let format = button("output-format")
            XCTAssertTrue(format.label.contains("Convert to"), "Output picker keeps its spoken purpose")
            if sample == "archive" {
                // The bundled archive sample selects the real unzip target.
                XCTAssertEqual(format.value as? String, "Extract archive")
            }
            let outputName = app.textFields["output-name"]
            reveal(outputName, "output-name")
            XCTAssertEqual(outputName.label, sample == "archive" ? "Folder name" : "Output file name")
            // The visible captions are hidden from VoiceOver to avoid duplicate
            // names. Keep an attachment for reviewing the Convert to caption.
            let configuration = XCTAttachment(screenshot: app.screenshot())
            configuration.name = "review-configuration-" + sample; configuration.lifetime = .keepAlways; add(configuration)
            let convert = button("convert-local")
            XCTAssertEqual(convert.label, "Convert")
            convert.tap()
            XCTAssertTrue(app.buttons["save-output"].waitForExistence(timeout: 60), sample)
            XCTAssertEqual(app.buttons["save-output"].label, "Save as…")
            let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = "review-" + sample; capture.lifetime = .keepAlways; add(capture)
            if sample == "image" || sample == "archive" {
                tap("save-output")
                XCTAssertTrue(app.buttons["DOCPicker.actionButton"].waitForExistence(timeout: 30), "System Files save picker: " + sample)
                let picker = XCTAttachment(screenshot: app.screenshot()); picker.name = "review-system-save-" + sample; picker.lifetime = .keepAlways; add(picker)
                dismissSavePicker()
                tap("save-output")
                XCTAssertTrue(app.buttons["DOCPicker.actionButton"].waitForExistence(timeout: 10), "Save can be retried: " + sample)
                dismissSavePicker()
            }
            let clear = button("clear-job")
            XCTAssertGreaterThanOrEqual(clear.frame.height, 44, "Clear touch height: " + sample)
            clear.tap()
            XCTAssertTrue(app.buttons["try-sample"].waitForExistence(timeout: 10), "Cleared job")
        }
        XCTAssertFalse(app.staticTexts["Sign in"].exists)
    }
}
