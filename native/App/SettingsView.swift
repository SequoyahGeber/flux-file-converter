// SHARED-EXPERIENCE: settings | standard: PROJECT_STANDARDS.md §Settings | local implementation; changes must be mirrored in every app listed there
#if os(iOS)
import SwiftUI
import SharedAbout
import SharedDesign
import SharedDiagnostics
import SharedFeedback

/// iPhone Settings sheet in the standard order: Appearance, Diagnostics, Help, About.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(FluxSettings.Key.appearanceMode) private var appearance = AppearanceMode.system.rawValue

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(AppearanceMode.allCases) { Text($0.title).tag($0.rawValue) }
                    }.pickerStyle(.segmented).accessibilityIdentifier(AccessibilityID.Settings.appearance)
                } header: { header("Appearance") }
                Section {
                    // The row names what it opens, so it never repeats its section header.
                    NavigationLink("Recent log") {
                        DiagnosticsView(center: FluxDiagnostics.center, sensitiveTerms: { FluxDiagnostics.fileNames() })
                            .navigationTitle("Diagnostics").navigationBarTitleDisplayMode(.inline)
                    }.accessibilityIdentifier(AccessibilityID.Settings.diagnostics)
                } header: { header("Diagnostics") }
                // "Support", "Send feedback" (no screenshot from Settings, D-011); then "Version",
                // "Acknowledgements", "Privacy policy".
                // System blue on white fails the audit's contrast check; Flux's link colour passes (as on the converter).
                HelpSettingsSection(configuration: FluxAbout.configuration) { FluxFeedback.center.open(.settings) }
                    .tint(FluxColor.link)
                AboutSettingsSection(configuration: FluxAbout.configuration) { FluxAbout.privacyPolicyText }
            }
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    // Bar buttons stop growing with Dynamic Type; a long press shows it large instead (audit).
                    Button("Done") { dismiss() }.accessibilityShowsLargeContentViewer().accessibilityIdentifier(AccessibilityID.Settings.done)
                }
            }
        }
        .presentationDetents([.large])
    }

    /// The system grey section header fails the accessibility audit's contrast check ("nearly passed"); SharedKit's
    /// Help and About headers use this colour (SK-B-03).
    private func header(_ title: LocalizedStringKey) -> some View {
        Text(title).foregroundStyle(SharedTextColor.secondary.color)
    }
}
#endif
