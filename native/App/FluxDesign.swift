// SHARED-EXPERIENCE: design | standard: PROJECT_STANDARDS.md §Design | package: SharedKit/Design 0.x
import SwiftUI

/// Flux's native design tokens on the shared structure (PLAN.md §4.8): one spacing scale and one radius scale with
/// the standard names, colour roles, and one icon enum. The embedded web UI keeps its own CSS (`src/styles.css`).
/// SharedDesign 0.4.0 does not ship tokens yet; these move onto it when it does.
enum FluxSpace {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32
}

enum FluxRadius {
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
}

/// Colour roles. System colours already carry light, dark and increased-contrast values.
enum FluxColor {
    static let accent = Color.purple
    static let success = Color.green
    static let failure = Color.red
    static let successBackground = Color.green.opacity(0.08)
    static let card = HierarchicalShapeStyle.quaternary
}

enum FluxType {
    static let badge = Font.title
    static let body = Font.callout
    static let detail = Font.caption
}

/// Every SF Symbol the native screens use (no raw symbol literals elsewhere). The standard concepts use the
/// standard names (PLAN.md §4.8); the rest are Flux's own.
enum FluxIcon: String {
    // Standard concepts.
    case settings = "gearshape"
    case feedback = "exclamationmark.bubble"
    case delete = "trash"
    case share = "square.and.arrow.up"
    case retry = "arrow.clockwise"
    case warning = "exclamationmark.triangle.fill"
    case error = "xmark.octagon.fill"
    case success = "checkmark.circle.fill"
    case info = "info.circle"
    // Flux's own.
    case appMark = "arrow.left.arrow.right"
    case onDevice = "lock.shield"
    case chooseFiles = "plus.circle.fill"
    case sample = "sparkles"
    case file = "doc"
    case convert = "arrow.triangle.2.circlepath"
    case save = "square.and.arrow.down"

    var systemName: String { rawValue }
}

extension Image {
    init(icon: FluxIcon) { self.init(systemName: icon.systemName) }
}

extension Label where Title == Text, Icon == Image {
    @_disfavoredOverload
    init(_ title: some StringProtocol, icon: FluxIcon) { self.init(title, systemImage: icon.systemName) }
    init(_ title: LocalizedStringKey, icon: FluxIcon) { self.init(title, systemImage: icon.systemName) }
}
