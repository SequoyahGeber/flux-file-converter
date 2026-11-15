// SHARED-EXPERIENCE: design | standard: PROJECT_STANDARDS.md §Design | package: SharedKit/Design 0.x
import SwiftUI
import SharedDesign
import SharedStrings

/// Every SF Symbol Flux's native screens use; views never name a symbol directly (PLAN.md §4.8). The standard
/// concepts use `StandardSymbol`'s names; SharedKit's lint reads this file as Flux's symbol file. Views use
/// SharedDesign's `Image(symbol:)` and `Label(_:symbol:)`.
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
