// SHARED-EXPERIENCE: about | standard: PROJECT_STANDARDS.md §About | package: SharedKit/About 0.x
import SwiftUI
import OfflineKit
import SharedAbout

/// Flux's Help and About sections, its privacy policy text and, on the Mac, its keyboard shortcuts (SharedAbout).
enum FluxAbout {
    static let configuration = AboutConfiguration(
        appName: "Flux", supportURL: ReviewResources.supportURL, privacyPolicyURL: ReviewResources.privacyURL,
        // D-044: the coordinator writes the support address in; the slot stays empty until then.
        supportAddress: nil,
        privacyPolicyUpdated: DateComponents(calendar: Calendar(identifier: .gregorian), year: 2026, month: 11, day: 15).date!,
        acknowledgements: ReviewResources.acknowledgements.map { Acknowledgement(name: $0.name, licence: $0.license) })

    /// The offline policy body; SharedAbout's frame adds "Updated …" before it and the web link after it.
    @ViewBuilder static var privacyPolicyText: some View {
        Text(ReviewResources.privacyText).font(.body).textSelection(.enabled)
            .accessibilityIdentifier(AccessibilityID.Privacy.text)
        Text("Website links open only when you choose them. Local conversion works offline.")
            .font(.caption).foregroundStyle(.secondary)
    }

    #if os(macOS)
    /// Help ▸ Keyboard Shortcuts: every shortcut in the menu bar, by menu (D-010).
    static let shortcuts: [KeyboardShortcutSection] = [
        KeyboardShortcutSection("File", [
            KeyboardShortcutItem("Choose Files…", "⌘O"),
            KeyboardShortcutItem("Start Conversion, Compression or Archive", "⌘↩"),
            KeyboardShortcutItem("Cancel Batch", "⌘."),
        ]),
        KeyboardShortcutSection("View", [
            KeyboardShortcutItem("Bigger Text", "⌘+"),
            KeyboardShortcutItem("Smaller Text", "⌘−"),
            KeyboardShortcutItem("Actual Size", "⌘0"),
        ]),
        KeyboardShortcutSection("Go", [
            KeyboardShortcutItem("Convert Files", "⌘1"),
            KeyboardShortcutItem("Compress Files", "⌘2"),
            KeyboardShortcutItem("ZIP & Unzip", "⌘3"),
            KeyboardShortcutItem("Recent Files", "⌘4"),
            KeyboardShortcutItem("All Formats", "⌘5"),
        ]),
        KeyboardShortcutSection("Flux", [
            KeyboardShortcutItem("Settings…", "⌘,"),
            KeyboardShortcutItem("Quit Flux", "⌘Q"),
        ]),
        KeyboardShortcutSection("Help", [
            KeyboardShortcutItem("Keyboard Shortcuts", "⌘/"),
            KeyboardShortcutItem("Send Feedback…", "⌥⌘/"),
        ]),
    ]
    #endif
}
