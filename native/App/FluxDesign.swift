// SHARED-EXPERIENCE: design | standard: PROJECT_STANDARDS.md §Design | package: SharedKit/Design 0.x
import SwiftUI
import SharedDesign

/// Flux's native design tokens: an adapter onto SharedDesign (PLAN.md §4.8). The standard scale's steps are
/// SharedDesign's; Flux's views use these names. Values off the standard scale stay as they are ("no app changes
/// its look", PLAN.md §3) and are revisited screen by screen. The embedded web UI keeps its own CSS (`src/styles.css`).
enum FluxSpace {
    // The standard scale (PROJECT_STANDARDS.md §Design).
    static let xxs = Space.xxs
    static let xs = Space.xs
    static let s = Space.s
    static let m = Space.m
    static let l = Space.l
    static let xl = Space.xl
    static let xxl = Space.xxl
    static let xxxl = Space.xxxl

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

/// Flux's palette as SharedDesign colour tokens: Apple's system purple, green and red in all four appearances, so the
/// look is what it was with the system colours (D-088).
enum FluxPalette {
    static let accent = ColorToken(name: "accent", light: RGB(0xAF52DE), dark: RGB(0xBF5AF2),
                                   lightIncreasedContrast: RGB(0x8944AB), darkIncreasedContrast: RGB(0xDA8FFF))
    static let success = ColorToken(name: "success", light: RGB(0x34C759), dark: RGB(0x30D158),
                                    lightIncreasedContrast: RGB(0x248A3D), darkIncreasedContrast: RGB(0x30DB5B))
    static let critical = ColorToken(name: "critical", light: RGB(0xFF3B30), dark: RGB(0xFF453A),
                                     lightIncreasedContrast: RGB(0xD70015), darkIncreasedContrast: RGB(0xFF6961))
    /// Secondary text on the converter. The system secondary label (#8A8A8E over white) is 3.44:1, below 4.5:1 for
    /// small text. Light mode is darkened just enough to pass Apple's accessibility audit, which measures the rendered
    /// simulator pixels: there mid-greys render lighter (#656569 showed as #78787C on the #E4E4E4 card, 3.47:1).
    /// #515155 renders about #646468, 4.6:1 on the card. Dark mode keeps the system value.
    static let caption = ColorToken(name: "caption", light: RGB(0x515155), dark: RGB(0x8D8D93),
                                    lightIncreasedContrast: RGB(0x5A5A5E), darkIncreasedContrast: RGB(0xA3A3A9))
    /// Success and failure *text* in light mode: the system green and red are 2.09:1 on the success card and 3.55:1 on
    /// white, below 4.5:1 for body text. Each is darkened just enough to pass as rendered in the simulator audit (see
    /// `caption`): #1C692F about 4.6:1 on the card, #C42D25 about 4.6:1 on white (FX-B-06). Fills and dark mode keep
    /// the system values.
    static let successText = ColorToken(name: "successText", light: RGB(0x1C692F), dark: RGB(0x30D158),
                                        lightIncreasedContrast: RGB(0x248A3D), darkIncreasedContrast: RGB(0x30DB5B))
    static let criticalText = ColorToken(name: "criticalText", light: RGB(0xC42D25), dark: RGB(0xFF453A),
                                         lightIncreasedContrast: RGB(0xD70015), darkIncreasedContrast: RGB(0xFF6961))
    /// Links and menu pickers on the converter. The system blue renders #009EFF in the audited simulator (about
    /// 3:1 on white); #004087 renders about #0068A9, 4.65:1 on the #E4E4E4 card and 5.9:1 on white. Dark mode and
    /// Increased Contrast keep the system blues.
    static let link = ColorToken(name: "link", light: RGB(0x004087), dark: RGB(0x0A84FF),
                                 lightIncreasedContrast: RGB(0x003A7A), darkIncreasedContrast: RGB(0x409CFF))
    /// Filled buttons with white labels (Choose files, Save, Convert). White on the system purple is 4.13:1 in light
    /// mode and 3.52:1 in dark, below 4.5:1, and the audit flags it; the fill renders exactly as specified, so #9C49C6
    /// gives 5.0:1 in both. Increased Contrast uses the darker system purple (6.0:1).
    static let accentFill = ColorToken(name: "accentFill", light: RGB(0x9C49C6), dark: RGB(0x9C49C6),
                                       lightIncreasedContrast: RGB(0x8944AB), darkIncreasedContrast: RGB(0x8944AB))
    /// Set once at the root: the shared components colour by tone.
    static let tones = TonePalette(accent: accent.color, success: success.color, critical: critical.color)
}

/// Colour roles the views use.
enum FluxColor {
    static let accent = FluxPalette.accent.color
    static let accentFill = FluxPalette.accentFill.color
    static let success = FluxPalette.success.color
    static let failure = FluxPalette.critical.color
    static let successText = FluxPalette.successText.color
    static let failureText = FluxPalette.criticalText.color
    static let link = FluxPalette.link.color
    static let successBackground = FluxPalette.success.color.opacity(0.08)
    static let card = HierarchicalShapeStyle.quaternary
}

enum FluxType {
    static let badge = Font.title
}
