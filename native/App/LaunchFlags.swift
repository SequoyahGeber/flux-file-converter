// SHARED-EXPERIENCE: engineering | standard: PROJECT_STANDARDS.md §Engineering | local implementation; changes must be mirrored in every app listed there
import Foundation

/// Standard UI-test launch flags: `-uiTesting`, `-resetData`, `-demo`.
/// A saved setting can also be set for one launch through the argument domain, for example `-appearance.mode dark`.
enum LaunchFlags {
    private static let arguments = ProcessInfo.processInfo.arguments
    /// Running under UI tests or screenshot capture: no animations.
    static var uiTesting: Bool { arguments.contains("-uiTesting") }
    /// Start as a new install: every saved setting is removed before the UI appears.
    static var resetData: Bool { arguments.contains("-resetData") }
    /// Start with the fictional sample image selected.
    static var demo: Bool { arguments.contains("-demo") }

    static func applyBeforeLaunch() {
        if resetData { FluxSettings.reset() }
    }
}
