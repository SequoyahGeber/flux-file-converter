// SHARED-EXPERIENCE: design | standard: PROJECT_STANDARDS.md §Design | package: SharedKit/Design 0.x
import SwiftUI
import SharedDesign
import SharedStrings

/// Every SF Symbol Flux's native screens use; views never name a symbol directly (PLAN.md §4.8). The standard
/// concepts use `StandardSymbol`'s names; SharedKit's lint reads this file as Flux's symbol file.
enum FluxIcon: String, AppSymbol {
    // Standard concepts.
    case settings = "gearshape"  // StandardSymbol.settings
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

}

extension Image {
    init(icon: FluxIcon) { self.init(symbol: icon) }
}

/// SharedDesign's `Label(_:symbol:)` takes a `String`, which a literal title would bypass the string catalog with;
/// Flux's titles stay localizable through `LocalizedStringKey`.
extension Label where Title == Text, Icon == Image {
    @_disfavoredOverload
    init(_ title: some StringProtocol, icon: FluxIcon) { self.init(String(title), symbol: icon) }
    init(_ title: LocalizedStringKey, icon: FluxIcon) {
        self.init { Text(title) } icon: { Image(symbol: icon) }
    }
}
