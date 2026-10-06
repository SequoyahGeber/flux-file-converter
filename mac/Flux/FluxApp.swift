import SwiftUI
import WebKit

@main
struct FluxApp: App {
    @StateObject private var desktop = DesktopBridge()
    var body: some Scene {
        Window("Flux", id: "main") {
            // Fits a 13-inch display at its Larger Text setting (1024×640 points).
            DesktopWorkspace(webView: desktop.webView).frame(minWidth: 900, minHeight: 560)
        }.defaultSize(width: 1260, height: 850)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Choose Files…") { desktop.chooseFiles() }.keyboardShortcut("o")
            }
        }
    }
}
private struct DesktopWorkspace: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
