import SwiftUI
import WebKit

@main
@MainActor
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
                Button("Start Conversion, Compression or Archive") { activate(.start) }
                    .keyboardShortcut(.return, modifiers: .command)
                Button("Cancel Batch") { activate(.cancel) }
                    .keyboardShortcut(".", modifiers: .command)
            }
            CommandGroup(after: .toolbar) {
                Button("Zoom In") { zoom(by: 0.1) }
                    .keyboardShortcut("+", modifiers: [.command, .shift])
                Button("Zoom Out") { zoom(by: -0.1) }
                    .keyboardShortcut("-", modifiers: .command)
                Button("Actual Size") { desktop.webView.pageZoom = 1 }
                    .keyboardShortcut("0", modifiers: .command)
            }
            CommandMenu("Workspace") {
                Button("Convert Files") { activate(.convert) }.keyboardShortcut("1")
                Button("Compress Files") { activate(.compress) }.keyboardShortcut("2")
                Button("ZIP & Unzip") { activate(.archive) }.keyboardShortcut("3")
                Button("Recent Files") { activate(.history) }.keyboardShortcut("4")
                Button("All Formats") { activate(.formats) }.keyboardShortcut("5")
            }
        }
    }

    private func zoom(by step: Double) {
        // Session-only; rounding keeps repeated steps and Actual Size predictable.
        desktop.webView.pageZoom = min(2, max(0.5, ((desktop.webView.pageZoom + step) * 10).rounded() / 10))
    }

    private enum RendererAction: String {
        case start, cancel, convert, compress, archive, history, formats
    }

    private func activate(_ action: RendererAction) {
        // Native sheets and renderer dialogs must keep background actions blocked.
        guard desktop.webView.window?.attachedSheet == nil, NSApp.modalWindow == nil else { return }
        desktop.webView.callAsyncJavaScript("""
            if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
            const targets = {
                start: '.queue-bottom .primary-button',
                cancel: '.queue-bottom .secondary-button'
            };
            // Navigation spans two nav containers, so use the fixed ordered list.
            const navigation = ['convert', 'compress', 'archive', 'history', 'formats'];
            const index = navigation.indexOf(action);
            const button = index >= 0
                ? document.querySelectorAll('.sidebar .side-button')[index]
                : Object.hasOwn(targets, action) ? document.querySelector(targets[action]) : null;
            if (button && !button.disabled && !button.closest('[inert]') && button.getClientRects().length) {
                button.click();
            }
            """, arguments: ["action": action.rawValue], in: nil, in: .page, completionHandler: nil)
    }
}
private struct DesktopWorkspace: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
