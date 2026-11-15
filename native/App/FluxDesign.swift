// SHARED-EXPERIENCE: design | standard: PROJECT_STANDARDS.md §Design | package: SharedKit/Design 0.x
import SwiftUI

/// Flux's native design tokens: an adapter onto SharedDesign's structure (PLAN.md §4.8). The standard scale's steps
/// are the only place that will point at SharedDesign's tokens once 0.4.0 ships them; Flux's views use these names
/// and do not change. Values off the standard scale stay as they are ("no app changes its look", PLAN.md §3) and are
/// revisited screen by screen. The embedded web UI keeps its own CSS (`src/styles.css`).
enum FluxSpace {
    // The standard scale (PROJECT_STANDARDS.md §Design).
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 20
    static let xxl: CGFloat = 24
    static let xxxl: CGFloat = 32

    // Off the scale, kept for now.
    /// Between the title and the subtitle in the converter's header.
    static let titleLines: CGFloat = 5
    /// Between a field's caption and its control.
    static let label: CGFloat = 6
    /// Between the app mark and the title, and between the choose-files controls.
    static let item: CGFloat = 14
    /// Inside the converter's cards.
    static let card: CGFloat = 18
    /// Between the converter's sections.
    static let section: CGFloat = 22
}

enum FluxRadius {
    // Off the scale, kept for now.
    /// The app mark in the converter's header.
    static let badge: CGFloat = 15
    /// The converter's cards.
    static let card: CGFloat = 18
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
}
