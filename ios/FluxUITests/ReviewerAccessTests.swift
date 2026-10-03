import XCTest

final class ReviewerAccessTests: XCTestCase {
    func testReviewerCanReadPolicyConvertSamplesAndReachSystemSaveWithoutLogin() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        let workspace = app.scrollViews["converter-workspace"]
        func tap(_ id: String) {
            let button = app.buttons[id].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 10), id)
            for _ in 0..<4 {
                if button.isHittable && button.frame.midY < app.frame.maxY - 100 { break }
                workspace.swipeUp()
            }
            XCTAssertTrue(button.isHittable, id)
            button.tap()
        }
        func dismissSavePicker() {
            if app.buttons["Cancel"].exists {
                app.buttons["Cancel"].firstMatch.tap()
            } else {
                let handle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08))
                handle.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
            }
            let available = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: app.buttons["save-output"])
            XCTAssertEqual(XCTWaiter.wait(for: [available], timeout: 10), .completed, "Cancelled export stays available")
        }
        tap("privacy-support")
        XCTAssertTrue(app.staticTexts["offline-privacy"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["offline-privacy"].label.contains("collect no personal information"))
        tap("privacy-done")
        workspace.swipeDown()
        for sample in ["image", "document", "video", "data", "archive"] {
            workspace.swipeDown()
            tap("try-sample"); tap("sample-" + sample)
            tap("convert-local")
            XCTAssertTrue(app.buttons["save-output"].waitForExistence(timeout: 60), sample)
            let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = "review-" + sample; capture.lifetime = .keepAlways; add(capture)
            if sample == "image" {
                tap("save-output")
                XCTAssertTrue(app.buttons["DOCPicker.actionButton"].waitForExistence(timeout: 30), "System Files save picker")
                let picker = XCTAttachment(screenshot: app.screenshot()); picker.name = "review-system-save"; picker.lifetime = .keepAlways; add(picker)
                dismissSavePicker()
                tap("save-output")
                XCTAssertTrue(app.buttons["DOCPicker.actionButton"].waitForExistence(timeout: 10), "Save can be retried")
                dismissSavePicker()
            }
            tap("clear-job")
            XCTAssertTrue(app.buttons["try-sample"].waitForExistence(timeout: 10), "Cleared job")
        }
        XCTAssertFalse(app.staticTexts["Sign in"].exists)
    }
}
