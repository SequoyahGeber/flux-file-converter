import AppKit
import Observation
import WebKit
import SharedDiagnostics
import SharedFeedback
import UniformTypeIdentifiers
import OfflineKit

/// Only bundled UI can call this bridge. File access comes from native pickers,
/// never from a path or URL supplied by JavaScript.
@MainActor final class DesktopBridge: NSObject, ObservableObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
    let webView: LocalDesktopWebView
    private var files: [String: URL] = [:]
    private var scopedFiles: Set<String> = []
    private var results: [String: LocalResult] = [:]
    private var saved: [String: URL] = [:]
    private var history: [[String: Any]] = []
    /// The preferred save folder, kept across launches as an app-scoped bookmark (`output.folder`).
    /// Without a saved choice, every save dialog starts where macOS last left it, as before.
    @Published private(set) var outputFolder: URL?
    private var outputScoped = false
    /// Set by the main window so the bundled UI's Settings button opens the native Settings window.
    var openSettings: (() -> Void)?
    /// Set by the main window: shows it again after "Keep Flux Open" when the quit began by closing it.
    var reopenWindow: (() -> Void)?
    private var quitConfirmed = false
    private var keyMonitor: Any?
    private var demoPending = LaunchFlags.demo
    private var busy = false
    /// For the menu bar (FX-B-12): Start dims when the page has nothing to start, Cancel and the Go items follow the
    /// running batch. `canStart` comes from the page (`menuState`); `batchRunning` is native.
    @Published private(set) var canStart = false
    @Published private(set) var batchRunning = false
    /// Kept while its menu is open.
    private var sharePicker: NSSharingServicePicker?
    private var control: JobControl?
    private var cancelled = false
    /// Distributable builds use OfflineKit; only the personal build bundles the full engine.
    private let full = SharedMacEngine.isAvailable

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(DesktopAssets(), forURLScheme: "flux-app")
        webView = LocalDesktopWebView(frame: .zero, configuration: configuration)
        webView.underPageBackgroundColor = .windowBackgroundColor
        super.init()
        webView.pageZoom = TextSize.restored(from: .standard, key: FluxSettings.Key.textSize)
        OfflineEngine.clearTemporaryFiles()
        restoreOutputFolder()
        FluxDiagnostics.fileNames = { [weak self] in
            guard let self else { return [] }
            return self.files.values.map(\.lastPathComponent) + self.results.values.map(\.url.lastPathComponent)
                + self.saved.values.map(\.lastPathComponent)
        }
        // Bigger Text is ⌘+ in the menu; also accept ⌘= (the same key without Shift).
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, event.window === self.webView.window,
                  event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers == "=" else { return event }
            self.zoom(by: 1); return nil
        }
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
            SharedMacEngine.terminateAll()
        }
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "local")
        webView.navigationDelegate = self
        webView.onDragEnd = { [weak self] in self?.emit("update", ["dragEnded": true]) }
        webView.onWindow = { [weak self] in self?.guardCloseButton() }
        webView.onFiles = { [weak self] urls in
            guard let self else { return }
            guard !self.busy else { self.emit("update", ["bridgeError": "Finish or cancel the current batch before adding files."]); return }
            do { self.emit("files", try self.register(urls)) }
            catch { self.emit("update", ["bridgeError": error.localizedDescription]) }
        }
        loadInterface()
    }
    #if DEBUG
    /// -simulateLaunchFailure (Debug only, D-116): the first load fails, so the Mac UI test reaches the retry path.
    private var launchFailureSimulated = false
    #endif
    /// Compiles the network blocker, then loads the bundled page. WebKit requires the client entitlement to start even
    /// for local pages; the page has a separate fail-closed blocker for all network resources.
    private func loadInterface() {
        #if DEBUG
        if LaunchFlags.simulateLaunchFailure && !launchFailureSimulated {
            launchFailureSimulated = true
            // Never inside App.init: the alert waits until the app has finished launching.
            Task { @MainActor in self.showLaunchFailure(URLError(.resourceUnavailable)) }
            return
        }
        #endif
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ftp://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "FluxOfflineUI", encodedContentRuleList: rules) { [weak self] list, error in
            guard let self else { return }
            guard let list, error == nil else { self.showLaunchFailure(error ?? URLError(.unknown)); return }
            self.webView.configuration.userContentController.add(list)
            self.webView.load(URLRequest(url: URL(string: "flux-app://app/index.html")!))
        }
    }
    /// The page can't load without its network blocker. The alert keeps a way forward: Try Again recompiles and loads,
    /// Send Feedback… opens the form and brings the choice back when it closes (never an empty window), and Quit
    /// quits (FX-B-22).
    private func showLaunchFailure(_ failure: any Error) {
        FluxDiagnostics.center.journal.record(.error, .lifecycle, "launchFailed", ["error": .error(failure)])
        let alert = NSAlert()
        alert.messageText = "Flux could not start"
        alert.informativeText = "The local interface protection could not be loaded. Try again, or send feedback so the problem can be fixed."
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "Send Feedback…")
        alert.addButton(withTitle: "Quit Flux")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            loadInterface()
        case .alertSecondButtonReturn:
            Task { @MainActor in
                // The page never loaded, so a screenshot would be blank: send none (FX-A-17).
                await FluxFeedback.center.open(.launchProblem) { nil }
                await Self.feedbackClosed()
                self.showLaunchFailure(failure)
            }
        default:
            NSApplication.shared.terminate(nil)
        }
    }
    /// Returns once the feedback form is no longer presented.
    private static func feedbackClosed() async {
        // The form may appear a moment after `open` returns.
        for _ in 0..<20 where !FluxFeedback.center.isPresented { try? await Task.sleep(for: .milliseconds(100)) }
        while FluxFeedback.center.isPresented {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                // onChange runs before the new value is stored, so look again on the next main-actor turn.
                withObservationTracking { _ = FluxFeedback.center.isPresented } onChange: {
                    Task { @MainActor in continuation.resume() }
                }
            }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true && url?.scheme == "flux-app" && url?.host == "app" ? .allow : .cancel)
    }
    /// WebKit's page process can be killed (memory pressure during a large conversion). Without this the window
    /// stays blank. The page reloads; the running batch is stopped because the new page cannot follow it, and the
    /// history (with every unsaved result) comes back through `getState` (FX-A-10).
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        FluxDiagnostics.center.journal.record(.error, .lifecycle, "pageProcessEnded", ["running": .bool(control != nil)])
        if control != nil { cancelled = true; control?.cancel() }
        webView.load(URLRequest(url: URL(string: "flux-app://app/index.html")!))
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "flux-app", message.frameInfo.securityOrigin.host == "app",
              let body = message.body as? [String: Any], let method = body["method"] as? String else {
            replyHandler(nil, "The local interface is unavailable."); return
        }
        Task {
            do { replyHandler(try await handle(method, body["args"]), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }
    /// View ▸ Bigger Text (+1) and Smaller Text (-1); remembered across launches (FX-B-12).
    func zoom(by direction: Int) { setTextSize(TextSize.stepped(webView.pageZoom, by: direction)) }
    /// View ▸ Actual Size is `setTextSize(1)`.
    func setTextSize(_ value: Double) {
        let size = TextSize.clamped(value)
        webView.pageZoom = size
        TextSize.save(size, to: .standard, key: FluxSettings.Key.textSize)
    }
    /// Shows the folder picker; on a choice, saves it and tells the bundled UI.
    func chooseOutputFolder() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true; panel.prompt = "Choose save folder"
        panel.directoryURL = outputFolder
        guard await present(panel) == .OK, let url = panel.url else { return }
        setOutputFolder(url)
    }
    func forgetOutputFolder() {
        if outputScoped { outputFolder?.stopAccessingSecurityScopedResource() }
        outputFolder = nil; outputScoped = false
        UserDefaults.standard.removeObject(forKey: FluxSettings.Key.outputFolder)
        emit("update", ["outputDir": outputLabel])
    }
    func showOutputFolder() {
        if let outputFolder { NSWorkspace.shared.activateFileViewerSelecting([outputFolder]) }
    }
    private func setOutputFolder(_ url: URL) {
        if outputScoped { outputFolder?.stopAccessingSecurityScopedResource() }
        outputFolder = url; outputScoped = url.startAccessingSecurityScopedResource()
        do {
            let bookmark = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
            UserDefaults.standard.set(bookmark, forKey: FluxSettings.Key.outputFolder)
        } catch {
            // The folder works for this session but cannot be remembered: log it and say so (FX-A-15).
            FluxDiagnostics.center.journal.record(.error, .lifecycle, "outputFolderNotSaved", ["error": .error(error)])
            emit("update", ["bridgeError": "Flux will use this folder until it quits, but couldn’t remember it for next time."])
        }
        emit("update", ["outputDir": outputLabel])
    }
    private func restoreOutputFolder() {
        guard let bookmark = UserDefaults.standard.data(forKey: FluxSettings.Key.outputFolder) else { useUITestOutputFolder(); return }
        var stale = false
        // The saved choice is only replaced when the person chooses again or forgets it: a folder on
        // an unmounted volume comes back once the volume does. Until then saves start where macOS left off.
        guard let restored = OutputFolderRestore.restore(
            resolve: { try? URL(resolvingBookmarkData: bookmark, options: .withSecurityScope, relativeTo: nil, bookmarkDataIsStale: &stale) },
            startAccess: { $0.startAccessingSecurityScopedResource() },
            stopAccess: { $0.stopAccessingSecurityScopedResource() },
            exists: { FileManager.default.fileExists(atPath: $0.path) }) else { return }
        let url = restored.url
        outputFolder = url; outputScoped = restored.scoped
        if stale {
            do { UserDefaults.standard.set(try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil), forKey: FluxSettings.Key.outputFolder) }
            catch { FluxDiagnostics.center.journal.record(.error, .lifecycle, "outputFolderNotRefreshed", ["error": .error(error)]) }
        }
    }
    /// Mac UI tests save into a folder inside the test app's own sandbox container, never a real folder (Debug,
    /// -uiTesting only). It acts as the Settings folder, so Save All writes there without a panel.
    private func useUITestOutputFolder() {
        #if DEBUG
        guard LaunchFlags.uiTesting else { return }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Flux UI test saves", isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        outputFolder = folder; outputScoped = false
        #endif
    }
    #if DEBUG
    /// What a -resetData launch does, done in place for the next Mac UI test (D-083): no feedback form, no files,
    /// results or history, default settings and text size, only the main window, and a freshly loaded page.
    func resetForUITests() {
        FluxFeedback.center.close()
        FluxFeedback.center.discardDraft()
        if control != nil { cancelled = true; control?.cancel() }
        for result in results.values { result.remove() }
        results = [:]; saved = [:]; history = []
        for id in scopedFiles { files[id]?.stopAccessingSecurityScopedResource() }
        files = [:]; scopedFiles = []
        if outputScoped { outputFolder?.stopAccessingSecurityScopedResource() }
        outputFolder = nil; outputScoped = false
        FluxSettings.reset()
        useUITestOutputFolder()
        quitConfirmed = false; demoPending = LaunchFlags.demo; canStart = false
        webView.pageZoom = 1
        for window in NSApp.windows where window !== webView.window && window.isVisible { window.close() }
        webView.window?.makeKeyAndOrderFront(nil)
        webView.load(URLRequest(url: URL(string: "flux-app://app/index.html")!))
    }
    #endif
    /// "Clear history" is always confirmed when there is history to clear (D-023).
    private func confirmClearHistory() async -> Bool {
        guard !history.isEmpty else { return true }
        let alert = NSAlert()
        alert.messageText = "Clear history?"
        alert.informativeText = "Recent files and their temporary results are removed from Flux. Files you saved and your original files are kept."
        alert.addButton(withTitle: "Clear history").hasDestructiveAction = true
        alert.addButton(withTitle: "Cancel")
        guard let window = webView.window else { return alert.runModal() == .alertFirstButtonReturn }
        return await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0 == .alertFirstButtonReturn) }
        }
    }
    func chooseFiles() {
        Task {
            do { if let records = try await handle("selectFiles", nil) as? [[String: Any]] { emit("files", records) } }
            catch { emit("update", ["bridgeError": error.localizedDescription]) }
        }
    }
    private func handle(_ method: String, _ args: Any?) async throws -> Any {
        switch method {
        case "getState":
            var current = state()
            // -demo: the page's first state already holds the fictional sample image.
            if demoPending, let url = ReviewResources.samples.first?.url, let records = try? register([url]) { current["files"] = records }
            demoPending = false
            return current
        case "describeFormat":
            guard let ext = args as? String, ext.count <= 12 else { throw LocalError.unsupported }
            return targets(ext)
        case "selectFiles":
            guard !busy else { throw LocalError.invalid("Finish the current batch first.") }
            busy = true; defer { busy = false }
            let panel = NSOpenPanel(); panel.allowsMultipleSelection = true; panel.canChooseDirectories = false
            let response = await present(panel)
            return response == .OK ? try register(panel.urls) : []
        case "selectSample":
            guard !busy, let id = args as? String,
                  let sample = ReviewResources.samples.first(where: { $0.id == id }), let url = sample.url else { throw LocalError.invalid("Choose an available sample.") }
            return try register([url])
        case "selectOutput":
            guard !busy else { throw LocalError.invalid("Finish the current batch first.") }
            await chooseOutputFolder(); return outputLabel
        case "openSettings": openSettings?(); return true
        case "menuState":
            guard let state = args as? [String: Any] else { throw LocalError.invalid("The local interface is unavailable.") }
            canStart = state["canStart"] as? Bool ?? false
            return true
        case "confirmClearHistory":
            guard !busy else { throw LocalError.invalid("Finish the current batch first.") }
            return await confirmClearHistory()
        case "releaseFiles":
            guard !busy, let ids = args as? [String], ids.count <= 100 else { throw LocalError.invalid("Finish the current batch first.") }
            for id in ids { if scopedFiles.remove(id) != nil { files[id]?.stopAccessingSecurityScopedResource() }; files.removeValue(forKey: id) }
            return true
        case "start":
            guard !busy, let jobs = args as? [[String: Any]], !jobs.isEmpty, jobs.count <= 100 else { throw LocalError.invalid("Choose up to 100 files and finish the current batch first.") }
            // Validate every identifier before starting any work.
            for job in jobs {
                guard let id = job["id"] as? String, files[id] != nil, let operation = job["operation"] as? String, ["convert", "compress", "pack", "extract"].contains(operation) else { throw LocalError.invalid("Choose the files again.") }
                if operation == "pack" {
                    guard jobs.count == 1, let ids = job["includeIds"] as? [String], !ids.isEmpty, ids.count <= 100, Set(ids).count == ids.count, ids.allSatisfy({ files[$0] != nil }) else { throw LocalError.invalid("Choose up to 100 files to ZIP.") }
                }
            }
            busy = true; cancelled = false; batchRunning = true
            Task { await run(jobs) }
            return true
        case "cancel": cancelled = true; control?.cancel(); return true
        case "reveal":
            guard !busy, let id = args as? String else { throw LocalError.invalid("Finish the current batch first.") }
            if let url = saved[id] { NSWorkspace.shared.activateFileViewerSelecting([url]); return true }
            guard let result = results[id] else { throw LocalError.invalid("This temporary result has been cleared. Convert the original again.") }
            try await save(result, id: id); return true
        case "saveAll":
            guard !busy else { throw LocalError.invalid("Finish the current batch first.") }
            return try await saveAll()
        case "share":
            guard !busy, let request = args as? [String: Any], let id = request["id"] as? String else { throw LocalError.invalid("Finish the current batch first.") }
            guard let result = results[id] else { throw LocalError.invalid("This temporary result has been cleared. Convert the original again.") }
            share(saved[id] ?? result.url, from: request["rect"] as? [String: Any])
            return true
        case "openOutput": if let outputFolder { NSWorkspace.shared.activateFileViewerSelecting([outputFolder]) }; return true
        case "clearHistory":
            guard !busy else { throw LocalError.invalid("Finish the current batch first.") }
            for result in results.values { result.remove() }; results = [:]; saved = [:]; history = []; return history
        case "openFormatList":
            let text = families.map { family in
                let exts = family["formats"] as! [String]
                return exts.map { ext in "\(ext.uppercased()) → \(targets(ext).map { $0.uppercased() }.joined(separator: ", "))" }.joined(separator: "\n")
            }.joined(separator: "\n\n")
            let alert = NSAlert(); alert.messageText = "Local conversion matrix"; alert.informativeText = "Compatible codecs and document contents determine whether a listed conversion can succeed. ZIP accepts every regular file type."
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 580, height: 380)); scroll.hasVerticalScroller = true
            let view = NSTextView(frame: scroll.bounds); view.isEditable = false; view.string = text; view.font = .monospacedSystemFont(ofSize: 11, weight: .regular); scroll.documentView = view; alert.accessoryView = scroll; alert.runModal(); return true
        default: throw LocalError.invalid("This action is unavailable in the local app.")
        }
    }
    private func present(_ panel: NSSavePanel) async -> NSApplication.ModalResponse {
        await withCheckedContinuation { continuation in
            if let window = webView.window {
                panel.beginSheetModal(for: window) { continuation.resume(returning: $0) }
            } else {
                panel.begin { continuation.resume(returning: $0) }
            }
        }
    }
    var outputLabel: String { outputFolder?.path ?? "Choose location when saving" }
    private func targets(_ ext: String) -> [String] {
        full ? SharedMacEngine.targets(ext) : LocalFormats.outputs(for: ext).filter { $0 != "unzip" }
    }
    private func fileExtension(_ url: URL) -> String { full ? SharedMacEngine.fileExtension(url) : url.pathExtension.lowercased() }
    private var families: [[String: Any]] {
        if full { return SharedMacEngine.families }
        return [("image", "Images", LocalFormats.images), ("video", "Video", LocalFormats.video), ("audio", "Audio", LocalFormats.audio),
         ("document", "Documents & ebooks", LocalFormats.documents), ("pdf", "PDF", ["pdf"]),
         ("data", "Structured data", LocalFormats.data), ("subtitle", "Subtitles", ["srt", "vtt"]), ("archive", "Archives", ["zip"])]
            .map { ["id": $0.0, "name": $0.1, "formats": $0.2] }
    }
    private func state() -> [String: Any] {
        ["nativeLocal": true, "fullEngine": full, "engines": ["local": true], "enginePaths": ["local": "Built into Flux · no downloads or server"], "outputDir": outputLabel,
         "history": history, "families": families, "running": busy, "files": [], "jobs": [],
         "samples": ReviewResources.samples.map { ["id": $0.id, "title": $0.title, "target": $0.target] },
         "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""]
    }
    private func register(_ urls: [URL]) throws -> [[String: Any]] {
        guard urls.count <= 100, files.count + urls.count <= 100 else { throw LocalError.invalid("Choose up to 100 files at a time.") }
        var added: [String] = []
        do {
            var records: [[String: Any]] = []
            for url in urls {
                guard url.isFileURL else { throw LocalError.invalid("Choose a local file.") }
                if files.values.contains(url) { continue }
                let scoped = url.startAccessingSecurityScopedResource()
                let id = UUID().uuidString; files[id] = url; added.append(id); if scoped { scopedFiles.insert(id) }
                let size = try LocalPolicy.fileSize(url), ext = fileExtension(url)
                let family = families.first { ($0["formats"] as! [String]).contains(ext) }?["id"] as? String ?? "unsupported"
                if full {
                    let media = ["video", "audio"].contains(SharedMacEngine.descriptor(ext)["family"] as? String ?? "")
                    guard size <= (media ? LocalPolicy.mediaLimit : SharedMacEngine.fileLimit) else { throw LocalError.invalid("Media is limited to 5 GB; other files to 1.9 GB.") }
                    let descriptor = SharedMacEngine.descriptor(ext)
                    let compression = descriptor["compressionOptions"] as? [[String: Any]] ?? [["id": "archive", "name": "Lossless ZIP", "note": "Preserves the complete original file."]]
                    records.append(["id": id, "path": id, "name": url.lastPathComponent, "ext": ext, "size": size, "family": family,
                        "defaultName": LocalPolicy.defaultOutputName(for: url),
                        "targets": targets(ext), "compressionOptions": compression,
                        "notes": (descriptor["notes"] as? [String: String] ?? [:]).merging(["zip": "Preserves the original file in a ZIP."]) { first, _ in first }])
                } else {
                    let media = LocalFormats.video.contains(ext) || LocalFormats.audio.contains(ext)
                    guard size <= (media ? LocalPolicy.mediaLimit : LocalPolicy.fileLimit) else { throw LocalError.invalid("Media is limited to 5 GB; other files to 512 MB.") }
                    var compression: [[String: String]] = [["id": "archive", "name": "Lossless ZIP", "note": "Keeps the complete original file in a ZIP. Compression may not reduce its size."]]
                    if media || LocalFormats.images.contains(ext) || ext == "pdf" {
                        compression.append(["id": "lossy", "name": "Smaller file", "note": ext == "pdf" ? LocalFormats.note(source: "pdf", target: "pdf", lossless: false) : "Re-encodes locally with reduced quality. Size reduction depends on the source."])
                    }
                    records.append(["id": id, "path": id, "name": url.lastPathComponent, "ext": ext, "size": size, "family": family,
                        "defaultName": LocalPolicy.defaultOutputName(for: url),
                        "targets": targets(ext), "compressionOptions": compression,
                        "notes": Dictionary(uniqueKeysWithValues: targets(ext).map { ($0, LocalFormats.note(source: ext, target: $0, lossless: true)) })])
                }
            }
            return records
        } catch {
            for id in added { if scopedFiles.remove(id) != nil { files[id]?.stopAccessingSecurityScopedResource() }; files.removeValue(forKey: id) }; throw error
        }
    }
    private func run(_ jobs: [[String: Any]]) async {
        for job in jobs {
            let id = job["id"] as! String, operation = job["operation"] as! String
            var update = job
            if cancelled { update["status"] = "cancelled"; update["progress"] = 0; emit("update", update); continue }
            let ids = operation == "pack" ? job["includeIds"] as! [String] : [id]
            guard let source = files[id] else { continue }
            let ext = fileExtension(source)
            let raw = job["options"] as? [String: Any] ?? [:]
            var options = ConversionOptions()
            options.quality = ["high": 0.95, "balanced": 0.85, "small": 0.55][raw["quality"] as? String ?? "balanced"] ?? 0.85
            options.lossless = raw["lossless"] as? Bool ?? true
            let target: String
            if operation == "pack" { target = "zip" }
            else if operation == "extract" { target = "unzip" }
            else if operation == "compress" {
                if job["compression"] as? String == "lossy" {
                    options.lossless = false
                    target = ext == "pdf" ? "pdf" : LocalFormats.images.contains(ext) ? "jpg" : LocalFormats.audio.contains(ext) ? "m4a" : "mp4"
                } else { target = "zip" }
            } else { target = job["target"] as? String ?? "" }
            let name = job["outputName"] as? String ?? (operation == "pack" ? "Archive" : LocalPolicy.defaultOutputName(for: source))
            // The full engine's worker enforces its own two-hour tool limit.
            let token = full ? JobControl(deadline: 2 * 60 * 60 + 600) : JobControl(); control = token
            // Neither engine reports progress, so the page shows an indeterminate bar, not a made-up percentage (FX-B-03).
            update["status"] = "running"; update["progress"] = NSNull(); emit("update", update)
            let started = Date()
            FluxDiagnostics.jobStarted(operation: operation, source: ext, target: target, files: ids.count)
            do {
                let inputs = ids.compactMap { files[$0] }
                let result: LocalResult
                if full {
                    var request = job
                    request["target"] = target
                    let specification = request
                    result = try await Task.detached(priority: .userInitiated) { try await SharedMacEngine.convert(inputs: inputs, job: specification, name: name, control: token) }.value
                } else {
                    let settings = options
                    result = try await Task.detached(priority: .userInitiated) { try await OfflineEngine.convert(inputs: inputs, target: target, name: name, options: settings, control: token) }.value
                }
                if token.isCancelled { result.remove(); try token.check() }
                let resultID = UUID().uuidString; results[resultID] = result
                let size = result.isDirectory ? Int64(0) : try LocalPolicy.fileSize(result.url)
                let record: [String: Any] = ["id": resultID, "name": result.url.lastPathComponent, "target": result.isDirectory ? "folder" : full ? result.url.pathExtension : target, "size": size,
                    "operation": operation, "sourceName": source.lastPathComponent, "sourceFamily": families.first { ($0["formats"] as! [String]).contains(ext) }?["id"] ?? "unsupported",
                    "completedAt": Date().timeIntervalSince1970 * 1000, "saved": false, "savedBytes": ((try? LocalPolicy.fileSize(source)) ?? 0) - size]
                history.insert(record, at: 0); update["result"] = record; update["status"] = "done"; update["progress"] = 100
                FluxDiagnostics.jobFinished(operation: operation, target: target, seconds: Date().timeIntervalSince(started))
                while history.count > 100 {
                    let discarded = history.removeLast()
                    if let discardedID = discarded["id"] as? String {
                        results.removeValue(forKey: discardedID)?.remove()
                        saved.removeValue(forKey: discardedID)
                    }
                }
            } catch {
                let stopped = cancelled || token.wasCancelled
                FluxDiagnostics.jobFailed(operation: operation, target: target, cancelled: stopped, error: error)
                // A cancel is shown as "Cancelled. You can try again." like the rest of the batch, never as an error (FX-B-04).
                update["status"] = stopped ? "cancelled" : "error"; update["progress"] = 0
                if !stopped { update["error"] = error.localizedDescription }
            }
            control = nil; emit("update", update)
        }
        busy = false; batchRunning = false; emit("update", ["batchComplete": true, "history": history])
    }
    /// The red close button quits Flux; it asks first, while the window is still there (FX-B-01). Other ways to close
    /// the window reach `confirmQuit` from the app delegate, which shows the window again if the person keeps Flux open.
    private func guardCloseButton() {
        guard let button = webView.window?.standardWindowButton(.closeButton), button.target !== self else { return }
        button.target = self; button.action = #selector(closeButtonClicked(_:))
    }
    /// Closing the main window quits Flux even when Settings or the shortcuts window is open, so a confirmed
    /// question is never left behind with the app still running.
    @objc private func closeButtonClicked(_ sender: Any?) { if confirmQuit() { NSApplication.shared.terminate(nil) } }
    /// Asks before quitting would stop a batch or delete unsaved results (FX-B-01). True means quit.
    func confirmQuit() -> Bool {
        if quitConfirmed { return true }
        let unsaved = results.keys.filter { saved[$0] == nil }.count
        guard let prompt = QuitPolicy.prompt(running: control != nil, unsaved: unsaved) else { return true }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = prompt.title
        alert.informativeText = prompt.message
        // Keeping Flux open is the default (Return and Escape); quitting would lose work.
        alert.addButton(withTitle: prompt.keep)
        let quit = alert.addButton(withTitle: prompt.quit)
        quit.hasDestructiveAction = true; quit.keyEquivalent = ""
        guard alert.runModal() == .alertSecondButtonReturn else { return false }
        quitConfirmed = true
        cancelled = true; control?.cancel()
        return true
    }
    private func save(_ result: LocalResult, id: String) async throws {
        guard !busy else { throw LocalError.invalid("Finish the current batch first.") }
        busy = true; defer { busy = false }
        let destination: URL
        if result.isDirectory {
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true; panel.prompt = "Save here"; panel.directoryURL = outputFolder
            guard await present(panel) == .OK, let parent = panel.url else { return }
            destination = parent.appendingPathComponent(result.url.lastPathComponent)
            let scoped = parent.startAccessingSecurityScopedResource(); defer { if scoped { parent.stopAccessingSecurityScopedResource() } }
            try await Task.detached {
                guard !FileManager.default.fileExists(atPath: destination.path) else { throw LocalError.invalid("A folder with this name already exists. Choose another location.") }
                try SafeSave.commit(result.url, to: destination, replaceExisting: false)
            }.value
        } else {
            let panel = NSSavePanel(); panel.nameFieldStringValue = result.url.lastPathComponent; panel.canCreateDirectories = true; panel.directoryURL = outputFolder
            panel.allowedContentTypes = [UTType(filenameExtension: result.url.pathExtension) ?? .data]
            guard await present(panel) == .OK, let url = panel.url else { return }; destination = url
            let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            try await Task.detached { try SafeSave.commit(result.url, to: destination) }.value
        }
        saved[id] = destination
        if let index = history.firstIndex(where: { $0["id"] as? String == id }) { history[index]["saved"] = true; history[index]["name"] = destination.lastPathComponent }
        emit("update", ["savedResult": id, "name": destination.lastPathComponent, "history": history])
    }
    /// Saves every unsaved result in one go (FX-B-11): into the Settings folder when one is chosen (its bookmark's
    /// access is already started), otherwise into one folder picked once. Names that are taken get " 2", " 3"; nothing
    /// is ever replaced. Each saved result is marked like a Save as… and the page shows one summary.
    private func saveAll() async throws -> Bool {
        let pending = history.compactMap { $0["id"] as? String }.filter { results[$0] != nil && saved[$0] == nil }
        guard !pending.isEmpty else { throw LocalError.invalid("Every result is already saved.") }
        busy = true; defer { busy = false }
        let folder: URL, scoped: Bool
        if let outputFolder {
            folder = outputFolder; scoped = false
        } else {
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
            panel.prompt = "Save All Here"; panel.message = SaveAllPolicy.panelMessage(count: pending.count)
            guard await present(panel) == .OK, let url = panel.url else { return false }
            folder = url; scoped = url.startAccessingSecurityScopedResource()
        }
        defer { if scoped { folder.stopAccessingSecurityScopedResource() } }
        var names: [String: String] = [:], failures: [String] = []
        for id in pending {
            guard let result = results[id] else { continue }
            do {
                let destination = try await Task.detached { () throws -> URL in
                    let name = LocalPolicy.uniqueName(result.url.lastPathComponent, isDirectory: result.isDirectory) {
                        FileManager.default.fileExists(atPath: folder.appendingPathComponent($0).path)
                    }
                    let destination = folder.appendingPathComponent(name, isDirectory: result.isDirectory)
                    try SafeSave.commit(result.url, to: destination, replaceExisting: false)
                    return destination
                }.value
                saved[id] = destination; names[id] = destination.lastPathComponent
                if let index = history.firstIndex(where: { $0["id"] as? String == id }) { history[index]["saved"] = true; history[index]["name"] = destination.lastPathComponent }
            } catch {
                FluxDiagnostics.center.journal.record(.error, .lifecycle, "saveAllFailed", ["error": .error(error)])
                failures.append(result.url.lastPathComponent)
            }
        }
        let message = SaveAllPolicy.summary(saved: names.count, failed: failures, folder: folder.lastPathComponent)
        emit("update", ["savedAll": Array(names.keys), "names": names, "history": history, "message": message])
        if !failures.isEmpty { emit("update", ["bridgeError": message]) }
        return true
    }
    /// The system share menu for one result, anchored to the page button the person clicked (FX-B-11).
    private func share(_ url: URL, from rect: [String: Any]?) {
        let number = { (key: String) in CGFloat((rect?[key] as? NSNumber)?.doubleValue ?? 0) }
        // Page coordinates are CSS pixels from the top left; the zoom scales them, and NSView's origin is the bottom left.
        let zoom = webView.pageZoom
        var anchor = NSRect(x: number("x") * zoom, y: number("y") * zoom, width: max(1, number("width") * zoom), height: max(1, number("height") * zoom))
        if !webView.isFlipped { anchor.origin.y = webView.bounds.height - anchor.maxY }
        if rect == nil { anchor = NSRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1) }
        let picker = NSSharingServicePicker(items: [url]); sharePicker = picker
        picker.show(relativeTo: anchor, of: webView, preferredEdge: .minY)
    }
    private func emit(_ event: String, _ value: Any) {
        guard JSONSerialization.isValidJSONObject(["event": event, "value": value]), let data = try? JSONSerialization.data(withJSONObject: ["event": event, "value": value]), let json = String(data: data, encoding: .utf8) else {
            FluxDiagnostics.center.journal.record(.error, .lifecycle, "bridgeUpdateDropped"); return
        }
        webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('flux-native', {detail: payload}));", arguments: ["payload": json], in: nil, in: .page, completionHandler: nil)
    }
}

final class LocalDesktopWebView: WKWebView {
    var onFiles: (([URL]) -> Void)?
    /// The page never receives `drop` for a native file drop, so it is told when any drag ends.
    var onDragEnd: (() -> Void)?
    /// Called when the view is placed in a window.
    var onWindow: (() -> Void)?
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); if window != nil { onWindow?() } }
    private func acceptsFiles(_ sender: NSDraggingInfo) -> NSDragOperation { sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ? .copy : [] }
    // super keeps WebKit's dragenter/dragover/dragleave sequence paired for the page.
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { _ = super.draggingEntered(sender); return acceptsFiles(sender) }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { _ = super.draggingUpdated(sender); return acceptsFiles(sender) }
    override func draggingExited(_ sender: NSDraggingInfo?) { super.draggingExited(sender); onDragEnd?() }
    // draggingEnded is optional and WKWebView does not implement it; an unguarded super call
    // throws inside AppKit's drag completion and leaves every later drag rejected.
    override func draggingEnded(_ sender: NSDraggingInfo) {
        if WKWebView.instancesRespond(to: #selector(NSDraggingDestination.draggingEnded(_:))) { super.draggingEnded(sender) }
        onDragEnd?()
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        // Conclude WebKit's drag session; this fires dragleave since the drop is handled natively.
        super.draggingExited(sender); onDragEnd?()
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty else { return false }
        onFiles?(urls); return true
    }
}

/// No network listener, arbitrary filesystem paths, or remote content.
final class DesktopAssets: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, url.scheme == "flux-app", url.host == "app", let root = Bundle.main.url(forResource: "DesktopUI", withExtension: nil) else { urlSchemeTask.didFailWithError(URLError(.unsupportedURL)); return }
        let parts = url.path.split(separator: "/").map(String.init)
        guard !parts.isEmpty, parts.count <= 2, parts.allSatisfy({ !$0.hasPrefix(".") && !$0.contains("\\") && !$0.contains("/") }), parts.count == 1 || parts[0] == "assets" else { urlSchemeTask.didFailWithError(URLError(.unsupportedURL)); return }
        let file = parts.reduce(root) { $0.appendingPathComponent($1) }
        let mime = ["html": "text/html", "js": "text/javascript", "css": "text/css", "svg": "image/svg+xml", "png": "image/png", "woff2": "font/woff2"][file.pathExtension]
        guard let mime, let data = try? Data(contentsOf: file), data.count < 10 * 1024 * 1024 else { urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return }
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: "utf-8")); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
