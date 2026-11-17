// SHARED-EXPERIENCE: mac-menus | standard: PROJECT_STANDARDS.md §Mac menus | local implementation; changes must be mirrored in every app listed there
import SwiftUI
import WebKit
import SharedAbout
import SharedDiagnostics
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
        let desktop = DesktopBridge()
        _desktop = StateObject(wrappedValue: desktop)
        // Fast Mac UI tests (D-083): the next test resets this app in place instead of relaunching it. Listens only
        // in a Debug build launched with -uiTesting; declines (and the test relaunches) when it asks for other arguments.
        #if DEBUG
        UITestResetListener.start { desktop.resetForUITests() }
        #endif
    }

    var body: some Scene {
        Window("Flux", id: "main") {
            MainWindow(desktop: desktop)
                .onAppear { appDelegate.desktop = desktop; applyAppearance() }
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
            // Help menu in the standard order after the system search field (§Mac menus): Keyboard Shortcuts,
            // Send Feedback…, Flux Support, Privacy Policy. Flux has no Help book, so the system item goes.
            CommandGroup(replacing: .help) {
                KeyboardShortcutsMenuButton()
                // The page is a WKWebView, so the screenshot comes from WebKit (FluxFeedback.open).
                Button("Send Feedback…") { FluxFeedback.open(.menu, webView: desktop.webView) }
                    .keyboardShortcut("/", modifiers: [.command, .option])
                SupportMenuButtons(configuration: FluxAbout.configuration)
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
        KeyboardShortcutsScene(sections: FluxAbout.shortcuts)
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

/// Flux has one window; closing it quits the app. Quitting asks first when it would stop a batch or delete
/// unsaved results (FX-B-01).
@MainActor final class FluxAppDelegate: NSObject, NSApplicationDelegate {
    weak var desktop: DesktopBridge?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let desktop, !desktop.confirmQuit() else { return .terminateNow }
        // The quit began by closing the window some other way (⌘W, File ▸ Close): bring it back.
        if !sender.windows.contains(where: { $0.isVisible && $0.canBecomeMain }) { desktop.reopenWindow?() }
        return .terminateCancel
    }
}

private struct MainWindow: View {
    @ObservedObject var desktop: DesktopBridge
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        // Fits a 13-inch display at its Larger Text setting (1024×640 points).
        DesktopWorkspace(webView: desktop.webView).frame(minWidth: 900, minHeight: 560)
            .onAppear { desktop.openSettings = { openSettings() }; desktop.reopenWindow = { openWindow(id: "main") } }
            .feedbackHost(FluxFeedback.center)
    }
}

private struct DesktopWorkspace: NSViewRepresentable {
    let webView: WKWebView
    func makeNSView(context: Context) -> WKWebView { webView }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
