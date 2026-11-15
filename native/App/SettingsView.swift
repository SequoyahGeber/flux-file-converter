// SHARED-EXPERIENCE: settings | standard: PROJECT_STANDARDS.md §Settings | local implementation; changes must be mirrored in every app listed there
#if os(iOS)
import SwiftUI
import OfflineKit
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
                    NavigationLink("Diagnostics") {
                        DiagnosticsView(center: FluxDiagnostics.center, sensitiveTerms: { FluxDiagnostics.fileNames() })
                            .navigationTitle("Diagnostics").navigationBarTitleDisplayMode(.inline)
                    }.accessibilityIdentifier(AccessibilityID.Settings.diagnostics)
                }
                Section("Help") {
                    Link("Support", destination: ReviewResources.supportURL)
                        .accessibilityIdentifier(AccessibilityID.Settings.support)
                    SendFeedbackSettingsRow(center: FluxFeedback.center)
                        .accessibilityIdentifier(AccessibilityID.Settings.sendFeedback)
                }
                Section("About") {
                    LabeledContent("Version") {
                        Text(AppVersion.display).textSelection(.enabled)
                    }.accessibilityIdentifier(AccessibilityID.Settings.version)
                    NavigationLink("Acknowledgements") { AcknowledgementsView() }
                        .accessibilityIdentifier(AccessibilityID.Settings.acknowledgements)
                    NavigationLink("Privacy policy") { PrivacyPolicyView() }
                        .accessibilityIdentifier(AccessibilityID.Settings.privacyPolicy)
                }
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
