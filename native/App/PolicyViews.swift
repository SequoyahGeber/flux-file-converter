import SwiftUI
import OfflineKit

/// The offline privacy policy, ending with its web copy.
struct PrivacyPolicyView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(ReviewResources.privacyText).font(.body).textSelection(.enabled)
                    .accessibilityIdentifier(AccessibilityID.Privacy.text)
                Link("Privacy policy on the web", destination: ReviewResources.privacyURL)
                    .accessibilityIdentifier(AccessibilityID.Privacy.webLink)
                Text("Website links open only when you choose them. Local conversion works offline.").font(.caption).foregroundStyle(.secondary)
            }.padding(24).frame(maxWidth: 700, alignment: .leading).frame(maxWidth: .infinity)
        }.navigationTitle("Privacy policy")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// Third-party code in the app and its licences.
struct AcknowledgementsView: View {
    var body: some View {
        List {
            ForEach(ReviewResources.acknowledgements, id: \.name) { item in
                Section(item.name) {
                    Text(item.license).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        }.navigationTitle("Acknowledgements")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

/// Wraps a policy screen for presentation as its own sheet with "Done".
struct PolicySheet<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    @ViewBuilder let content: Content
    var body: some View {
        NavigationStack {
            content.toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        #if os(macOS)
        .frame(width: 620, height: 560)
        #endif
    }
}
