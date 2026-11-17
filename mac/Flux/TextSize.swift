import Foundation

/// The page's text size (View ▸ Bigger Text, Smaller Text, Actual Size), kept apart from WebKit so
/// `tests/mac-policy.swift` can check it. It is remembered across launches under `appearance.textSize` (FX-B-12):
/// people who need big text no longer set it every launch.
enum TextSize {
    static let range = 0.5...2.0
    static let step = 0.1
    /// Rounded to tenths so repeated steps and Actual Size stay predictable, and kept in `range`.
    static func clamped(_ value: Double) -> Double {
        guard value.isFinite else { return 1 }
        return min(range.upperBound, max(range.lowerBound, (value * 10).rounded() / 10))
    }
    /// The size after one Bigger (+1) or Smaller (-1) step.
    static func stepped(_ value: Double, by direction: Int) -> Double { clamped(value + Double(direction) * step) }
    /// The saved size, or Actual Size when none is saved or the saved value is unusable.
    static func restored(from defaults: UserDefaults, key: String) -> Double {
        guard defaults.object(forKey: key) != nil else { return 1 }
        return clamped(defaults.double(forKey: key))
    }
    /// Saves `value`; Actual Size removes the setting, so a reset build and an untouched one look the same.
    static func save(_ value: Double, to defaults: UserDefaults, key: String) {
        if value == 1 { defaults.removeObject(forKey: key) } else { defaults.set(value, forKey: key) }
    }
}
