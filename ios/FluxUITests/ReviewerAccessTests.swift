import XCTest

final class ReviewerAccessTests: XCTestCase {
    func testReviewerCanReadPolicyConvertSamplesAndReachSystemSaveWithoutLogin() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        func tap(_ id: String) {
            let button = app.buttons[id].firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 10), id)
            for _ in 0..<4 { if button.isHittable { break }; app.scrollViews.firstMatch.swipeUp() }
            button.tap()
        }
        tap("privacy-support")
        XCTAssertTrue(app.staticTexts["offline-privacy"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["offline-privacy"].label.contains("collect no personal information"))
        tap("privacy-done")
        app.scrollViews.firstMatch.swipeDown()
        for sample in ["image", "document", "video", "data", "archive"] {
            app.scrollViews.firstMatch.swipeDown()
            tap("try-sample"); tap("sample-" + sample)
            tap("convert-local")
            XCTAssertTrue(app.buttons["save-output"].waitForExistence(timeout: 60), sample)
            let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = "review-" + sample; capture.lifetime = .keepAlways; add(capture)
            if sample == "image" {
                tap("save-output")
                XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10), "System Files save picker")
                app.buttons["Cancel"].firstMatch.tap()
                XCTAssertTrue(app.buttons["save-output"].waitForExistence(timeout: 10))
            }
            tap("Clear")
        }
        XCTAssertFalse(app.staticTexts["Sign in"].exists)
    }
}
