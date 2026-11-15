// SHARED-EXPERIENCE: design | standard: PROJECT_STANDARDS.md §Design | package: SharedKit/Design 0.x
import SwiftUI

/// Every SF Symbol Flux's native screens use; views never name a symbol directly (PLAN.md §4.8). The standard
/// concepts use the standard names. Adapter: once SharedKit 0.4.0 ships `AppSymbol` and `Image(symbol:)`, this enum
/// conforms to `AppSymbol` and the two extensions below forward to SharedDesign.
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
    /// The error line keeps its outlined triangle (no look change); `warning` is the standard filled one.
    case errorLine = "exclamationmark.triangle"

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
