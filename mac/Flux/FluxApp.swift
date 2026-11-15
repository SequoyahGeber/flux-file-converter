// SHARED-EXPERIENCE: mac-menus | standard: PROJECT_STANDARDS.md §Mac menus | local implementation; changes must be mirrored in every app listed there
import SwiftUI
import WebKit
import SharedFeedback

@main
@MainActor
struct FluxApp: App {
    @NSApplicationDelegateAdaptor(FluxAppDelegate.self) private var appDelegate
    @StateObject private var desktop: DesktopBridge
    @AppStorage(FluxSettings.Key.appearanceMode) private var appearance = AppearanceMode.system.rawValue

    init() {
        LaunchFlags.applyBeforeLaunch()
        // Diagnostics and feedback start before anything can fail, so the launch-failure alert can offer feedback.
        FluxDiagnostics.start()
        _ = FluxFeedback.center
        #if DEBUG
        FluxFeedback.sendTestReportIfAsked()
        #endif
        _desktop = StateObject(wrappedValue: DesktopBridge())
    }

    var body: some Scene {
        Window("Flux", id: "main") {
            MainWindow(desktop: desktop)
                .onAppear { applyAppearance() }
                .onChange(of: appearance) { applyAppearance() }
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
                // ⌘= is also accepted for Bigger Text (DesktopBridge's key monitor).
                Button("Bigger Text") { desktop.zoom(by: 0.1) }
                    .keyboardShortcut("+", modifiers: .command)
                Button("Smaller Text") { desktop.zoom(by: -0.1) }
                    .keyboardShortcut("-", modifiers: .command)
                Button("Actual Size") { desktop.webView.pageZoom = 1 }
                    .keyboardShortcut("0", modifiers: .command)
            }
            CommandGroup(after: .help) {
                // The page is a WKWebView, so the screenshot comes from a web snapshot (FluxFeedback.open).
                Button("Send Feedback…") { FluxFeedback.open(.menu, webView: desktop.webView) }
                    .keyboardShortcut("/", modifiers: [.command, .option])
            }
            CommandMenu("Go") {
                Button("Convert Files") { activate(.convert) }.keyboardShortcut("1")
                Button("Compress Files") { activate(.compress) }.keyboardShortcut("2")
                Button("ZIP & Unzip") { activate(.archive) }.keyboardShortcut("3")
                Button("Recent Files") { activate(.history) }.keyboardShortcut("4")
                Button("All Formats") { activate(.formats) }.keyboardShortcut("5")
            }
        }
        Settings {
            MacSettingsView(desktop: desktop)
                .preferredColorScheme((AppearanceMode(rawValue: appearance) ?? .system).colorScheme)
        }
    }

    private func applyAppearance() {
        // The embedded UI follows the window appearance through prefers-color-scheme.
        switch AppearanceMode(rawValue: appearance) ?? .system {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
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

/// Flux has one window; closing it quits the app.
final class FluxAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

private struct MainWindow: View {
    @ObservedObject var desktop: DesktopBridge
    @Environment(\.openSettings) private var openSettings
    var body: some View {
        // Fits a 13-inch display at its Larger Text setting (1024×640 points).
        DesktopWorkspace(webView: desktop.webView).frame(minWidth: 900, minHeight: 560)
            .onAppear { desktop.openSettings = { openSettings() } }
            .feedbackHost(FluxFeedback.center)
    }
}

private struct DesktopWorkspace: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
