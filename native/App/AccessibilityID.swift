// SHARED-EXPERIENCE: engineering | standard: PROJECT_STANDARDS.md §Engineering | local implementation; changes must be mirrored in every app listed there
/// Every accessibility identifier in the native apps. Tests find controls by these ids, never by display text.
/// Style: dotted, lowercase first segment, camelCase after it.
enum AccessibilityID {
    enum Converter {
        static let workspace = "converter.workspace"
        static let chooseFiles = "converter.chooseFiles"
        static let trySample = "converter.trySample"
        static func sample(_ id: String) -> String { "converter.sample." + id }
        static let outputFormat = "converter.outputFormat"
        static let outputName = "converter.outputName"
        static let convert = "converter.convert"
        static let save = "converter.save"
        static let clear = "converter.clear"
        static let clearConfirm = "converter.clearConfirm"
        static let supportedConversions = "converter.supportedConversions"
        static let notice = "converter.notice"
    }
    enum Settings {
        static let open = "settings.open"
        static let done = "settings.done"
        static let appearance = "settings.appearance"
        static let support = "settings.support"
        static let version = "settings.version"
        static let acknowledgements = "settings.acknowledgements"
        static let privacyPolicy = "settings.privacyPolicy"
        static let outputFolder = "settings.outputFolder"
        static let chooseOutputFolder = "settings.chooseOutputFolder"
        static let showOutputFolder = "settings.showOutputFolder"
        static let forgetOutputFolder = "settings.forgetOutputFolder"
        static let diagnostics = "settings.diagnostics"
    }
    enum Privacy {
        static let text = "privacy.text"
        static let webLink = "privacy.webLink"
    }
    enum Formats {
        static let done = "formats.done"
    }
}
