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
            usesStandIn: LaunchFlags.feedbackStandIn && !debugCloudKitDelivery,
            sensitiveTerms: { FluxDiagnostics.fileNames() },
            context: { FluxFeedback.context() }),
        diagnostics: FluxDiagnostics.center)

    /// `-feedbackDelivery cloudkit` sends even under `-demo`, for the round-trip proof (D-072). Debug builds only.
    static var debugCloudKitDelivery: Bool {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-feedbackDelivery"), index + 1 < arguments.count else { return false }
        return arguments[index + 1] == "cloudkit"
        #else
        return false
        #endif
    }

    #if DEBUG
    /// Round-trip proof (D-072): `-feedbackDelivery cloudkit -sendTestFeedback -demo` sends one fictional report,
    /// prints the outcome on standard output and quits. Run only in the `.devfeedback` build, in its own sandbox.
    static func sendTestReportIfAsked() {
        guard ProcessInfo.processInfo.arguments.contains("-sendTestFeedback") else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            center.open(.button)
            center.edit {
                $0.category = FeedbackCategory.other.id
                $0.message = "Flux round-trip test report. Fictional; sent by -sendTestFeedback (D-072)."
                $0.includeScreenshot = false
            }
            await center.review()
            await center.send()
            print("sendTestFeedback: \(String(describing: center.draft?.phase))")
            fflush(stdout)
            exit(center.draft?.phase == .sent ? 0 : 1)
        }
    }
    #endif

    #if os(macOS)
    /// Opens the form with a screenshot of the window. The window's content is a WKWebView, which AppKit's view
    /// caching draws blank, so the page is snapshotted through WebKit (SharedKit's screenshot provider, 0.3.0).
    static func open(_ source: FeedbackSource, webView: WKWebView) {
        Task { await center.open(source, window: webView.window) { await snapshot(of: webView) } }
    }

    private static func snapshot(of webView: WKWebView) async -> CGImage? {
        await withCheckedContinuation { continuation in
            webView.takeSnapshot(with: nil) { image, _ in
                continuation.resume(returning: image?.cgImage(forProposedRect: nil, context: nil, hints: nil))
            }
        }
    }
    #endif
}
