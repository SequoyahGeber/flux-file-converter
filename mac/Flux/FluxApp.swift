import SwiftUI
import WebKit

@main
struct FluxApp: App {
    @StateObject private var desktop = DesktopBridge()
    var body: some Scene {
        Window("Flux", id: "main") {
            DesktopWorkspace(webView: desktop.webView).frame(minWidth: 1000, minHeight: 720)
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
