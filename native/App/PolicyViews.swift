import SwiftUI

/// Presents a screen (the Mac diagnostics log) as its own sheet with "Done".
struct DoneSheet<Content: View>: View {
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
