// SHARED-EXPERIENCE: settings | standard: PROJECT_STANDARDS.md §Settings | local implementation; changes must be mirrored in every app listed there
import SwiftUI
import OfflineKit

/// The Settings window (⌘,) in the standard order: Output folder (app-specific), Appearance, Help, About.
struct MacSettingsView: View {
    @ObservedObject var desktop: DesktopBridge
    @AppStorage(FluxSettings.Key.appearanceMode) private var appearance = AppearanceMode.system.rawValue
    @State private var showingPrivacy = false
    @State private var showingAcknowledgements = false

    var body: some View {
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
            Section("Help") {
                Link("Support", destination: ReviewResources.supportURL)
                    .accessibilityIdentifier(AccessibilityID.Settings.support)
            }
            Section("About") {
                LabeledContent("Version") { Text(AppVersion.display).textSelection(.enabled) }
                    .accessibilityIdentifier(AccessibilityID.Settings.version)
                Button("Acknowledgements") { showingAcknowledgements = true }
                    .accessibilityIdentifier(AccessibilityID.Settings.acknowledgements)
                Button("Privacy policy") { showingPrivacy = true }
                    .accessibilityIdentifier(AccessibilityID.Settings.privacyPolicy)
            }
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .fixedSize(horizontal: false, vertical: true)
        .sheet(isPresented: $showingPrivacy) { PolicySheet { PrivacyPolicyView() } }
        .sheet(isPresented: $showingAcknowledgements) { PolicySheet { AcknowledgementsView() } }
    }
}
