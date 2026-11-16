// SHARED-EXPERIENCE: settings | standard: PROJECT_STANDARDS.md §Settings | local implementation; changes must be mirrored in every app listed there
#if os(iOS)
import SwiftUI
import SharedAbout
import SharedDiagnostics
import SharedFeedback

/// iPhone Settings sheet in the standard order: Appearance, Diagnostics, Help, About.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(FluxSettings.Key.appearanceMode) private var appearance = AppearanceMode.system.rawValue

    var body: some View {
        NavigationStack {
            Form {
                Section("Appearance") {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(AppearanceMode.allCases) { Text($0.title).tag($0.rawValue) }
                    }.pickerStyle(.segmented).accessibilityIdentifier(AccessibilityID.Settings.appearance)
                }
                Section("Diagnostics") {
                    // The row names what it opens, so it never repeats its section header.
                    NavigationLink("Recent log") {
                        DiagnosticsView(center: FluxDiagnostics.center, sensitiveTerms: { FluxDiagnostics.fileNames() })
                            .navigationTitle("Diagnostics").navigationBarTitleDisplayMode(.inline)
                    }.accessibilityIdentifier(AccessibilityID.Settings.diagnostics)
                }
                // "Support", "Send feedback" (no screenshot from Settings, D-011); then "Version",
                // "Acknowledgements", "Privacy policy".
                HelpSettingsSection(configuration: FluxAbout.configuration) { FluxFeedback.center.open(.settings) }
                AboutSettingsSection(configuration: FluxAbout.configuration) { FluxAbout.privacyPolicyText }
            }
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier(AccessibilityID.Settings.done)
                }
            }
        }
        .presentationDetents([.large])
    }
}
#endif
