// SHARED-EXPERIENCE: settings | standard: PROJECT_STANDARDS.md §Settings | local implementation; changes must be mirrored in every app listed there
import SwiftUI
import SharedAbout
import SharedDiagnostics
import SharedFeedback

/// The Settings window (⌘,) in the standard order: Output folder (app-specific), Appearance, Diagnostics, Help, About.
struct MacSettingsView: View {
    @ObservedObject var desktop: DesktopBridge
    @AppStorage(FluxSettings.Key.appearanceMode) private var appearance = AppearanceMode.system.rawValue
    @State private var showingDiagnostics = false

    var body: some View {
        // About's rows push their screens, so the form sits in a navigation stack.
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Save folder") {
                        Text(desktop.outputFolder?.path ?? "Not chosen").lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled).foregroundStyle(desktop.outputFolder == nil ? .secondary : .primary)
                    }.accessibilityIdentifier(AccessibilityID.Settings.outputFolder)
                    HStack {
                        Button("Choose folder…") { Task { await desktop.chooseOutputFolder() } }
                            .accessibilityIdentifier(AccessibilityID.Settings.chooseOutputFolder)
                        Button("Show in Finder") { desktop.showOutputFolder() }.disabled(desktop.outputFolder == nil)
                            .accessibilityIdentifier(AccessibilityID.Settings.showOutputFolder)
                        Button("Forget folder") { desktop.forgetOutputFolder() }.disabled(desktop.outputFolder == nil)
                            .accessibilityIdentifier(AccessibilityID.Settings.forgetOutputFolder)
                    }
                } header: {
                    Text("Output folder")
                } footer: {
                    Text("Save dialogs start in this folder. Use Save as… on each result to pick its final name and location; an existing file is replaced only after the save dialog asks you.")
                        .foregroundStyle(.secondary)
                }
                Section("Appearance") {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(AppearanceMode.allCases) { Text($0.title).tag($0.rawValue) }
                    }.pickerStyle(.segmented).accessibilityIdentifier(AccessibilityID.Settings.appearance)
                }
                Section("Diagnostics") {
                    Button("Show recent log…") { showingDiagnostics = true }
                        .accessibilityIdentifier(AccessibilityID.Settings.diagnostics)
                }
                HelpSettingsSection(configuration: FluxAbout.configuration) { FluxFeedback.center.open(.settings) }
                AboutSettingsSection(configuration: FluxAbout.configuration) { FluxAbout.privacyPolicyText }
            }
            .formStyle(.grouped)
        }
        // Tall enough for the pushed privacy policy and acknowledgements.
        .frame(width: 520, height: 640)
        .sheet(isPresented: $showingDiagnostics) {
            PolicySheet {
                DiagnosticsView(center: FluxDiagnostics.center, sensitiveTerms: { FluxDiagnostics.fileNames() })
            }
        }
        .feedbackHost(FluxFeedback.center)
    }
}
