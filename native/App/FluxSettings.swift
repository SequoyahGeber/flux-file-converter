// SHARED-EXPERIENCE: settings | standard: PROJECT_STANDARDS.md §Settings | local implementation; changes must be mirrored in every app listed there
import SwiftUI

/// Every saved setting and its key. New keys are lowercase dotted (`group.name`).
enum FluxSettings {
    enum Key {
        static let appearanceMode = "appearance.mode"
        /// Mac only: an app-scoped security bookmark for the preferred save folder.
        static let outputFolder = "output.folder"
        /// Mac only: the page's text size (View ▸ Bigger Text), 0.5 to 2; absent means Actual Size (FX-B-12).
        static let textSize = "appearance.textSize"
    }
    static let all = [Key.appearanceMode, Key.outputFolder, Key.textSize]
    static func reset(_ defaults: UserDefaults = .standard) {
        for key in all { defaults.removeObject(forKey: key) }
    }
}

enum AppearanceMode: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
