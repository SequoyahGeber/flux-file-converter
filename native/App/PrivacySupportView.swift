import SwiftUI
import OfflineKit

struct PrivacySupportView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("Privacy policy").font(.title2.bold())
                    Text(ReviewResources.privacyText).font(.body).textSelection(.enabled)
                        .accessibilityIdentifier("offline-privacy")
                    Link("Public privacy policy", destination: ReviewResources.privacyURL)
                    Divider()
                    Text("Support").font(.title2.bold())
                    Text(ReviewResources.supportText).font(.body).textSelection(.enabled)
                    Link("Support page", destination: ReviewResources.supportURL)
                    Text("Website links open only when you choose them. Local conversion works offline.").font(.caption).foregroundStyle(.secondary)
                }.padding(24).frame(maxWidth: 700).frame(maxWidth: .infinity)
            }.navigationTitle("Privacy & support")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("privacy-done") } }
        }
        #if os(macOS)
        .frame(width: 660, height: 600)
        #endif
    }
}
