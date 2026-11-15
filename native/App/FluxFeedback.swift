// SHARED-EXPERIENCE: feedback | standard: PROJECT_STANDARDS.md §Feedback | package: SharedKit/Feedback 0.x
import SwiftUI
import SharedDiagnostics
import SharedFeedback
#if os(macOS)
import AppKit
import WebKit
#endif

/// Flux's one feedback form, made at launch before anything can fail (SharedKit README, "Feedback and diagnostics").
/// Reports go to the public database of `iCloud.com.sequoyah.flux`. File names and output names chosen in this
/// session are redacted from the log; the screenshot is on by default and the form notes it may show file names (D-023).
@MainActor
enum FluxFeedback {
    static let containerID = "iCloud.com.sequoyah.flux"

    /// Where the person is, in words and tokens. Set by the screen on display.
    static var context: @MainActor () -> FeedbackContext = { FeedbackContext(screen: "Converter", tokens: ["screen=converter"]) }

    static let center = FeedbackCenter(
        configuration: FeedbackConfiguration(
            appName: "Flux", containerID: containerID, redactor: FluxDiagnostics.redactor,
            screenshot: .standard, screenshotNote: "May show the names of files you chose and their results.",
            sensitiveTerms: { FluxDiagnostics.fileNames() },
            context: { FluxFeedback.context() }),
        diagnostics: FluxDiagnostics.center)

    #if os(macOS)
    /// Opens the form with a screenshot of the window. The window's content is a WKWebView, which AppKit's view
    /// caching draws blank, so the web page is snapshotted first and laid over the web view while the form opens.
    static func open(_ source: FeedbackSource, webView: WKWebView) {
        guard !center.isPresented else { return }
        guard source != .settings, let window = webView.window else {
            center.open(source, window: webView.window)
            return
        }
        webView.takeSnapshot(with: nil) { image, _ in
            MainActor.assumeIsolated {
                guard let image else { center.open(source, window: window); return }
                let cover = NSImageView(frame: webView.bounds)
                cover.image = image
                cover.imageScaling = .scaleAxesIndependently
                cover.autoresizingMask = [.width, .height]
                webView.addSubview(cover)
                center.open(source, window: window)
                cover.removeFromSuperview()
            }
        }
    }
    #endif
}
