// SHARED-EXPERIENCE: engineering | standard: PROJECT_STANDARDS.md §Engineering | local implementation; changes must be mirrored in every app listed there
import Foundation

/// Standard UI-test launch flags: `-uiTesting`, `-resetData`, `-demo`.
/// A saved setting can also be set for one launch through the argument domain, for example `-appearance.mode dark`.
///
/// D-116: a Release build ignores all three. They reset real settings, seed the queue and route feedback to a
/// stand-in inbox, none of which a shipped app may do from a launch argument.
enum LaunchFlags {
    #if DEBUG
    private static let arguments = ProcessInfo.processInfo.arguments
    #else
    private static let arguments: [String] = []
    #endif
    /// Running under UI tests or screenshot capture: no animations.
    static var uiTesting: Bool { arguments.contains("-uiTesting") }
    /// Start as a new install: every saved setting is removed before the UI appears.
    static var resetData: Bool { arguments.contains("-resetData") }
    /// Start with the fictional sample image selected.
    static var demo: Bool { arguments.contains("-demo") }
    /// Mac: the first load of the page fails, so UI tests reach the launch-failure alert (FX-B-22). Debug only.
    static var simulateLaunchFailure: Bool { arguments.contains("-simulateLaunchFailure") }
    /// Feedback goes to SharedKit's stand-in inbox instead of CloudKit (UI tests and screenshots, Debug only).
    static var feedbackStandIn: Bool { uiTesting || demo }

    static func applyBeforeLaunch() {
        if resetData { FluxSettings.reset() }
    }
}
