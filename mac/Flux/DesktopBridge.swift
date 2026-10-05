import AppKit
import WebKit
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
    private var outputFolder: URL?
    private var outputScoped = false
    private var busy = false
    private var control: JobControl?
    private var cancelled = false

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(DesktopAssets(), forURLScheme: "flux-app")
        webView = LocalDesktopWebView(frame: .zero, configuration: configuration)
        super.init()
        OfflineEngine.clearTemporaryFiles()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "local")
        webView.navigationDelegate = self
        webView.onFiles = { [weak self] urls in
            guard let self, !self.busy else { return }
            do { self.emit("files", try self.register(urls)) }
            catch { self.emit("update", ["bridgeError": error.localizedDescription]) }
        }
        // WebKit requires the client entitlement to start even for local pages.
        // Its UI has a separate fail-closed blocker for all network resources.
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ftp://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "FluxOfflineUI", encodedContentRuleList: rules) { [weak self] list, error in
            guard let self else { return }
            guard let list, error == nil else {
                let alert = NSAlert()
                alert.messageText = "Flux could not start"
                alert.informativeText = "The local interface protection could not be loaded. Close Flux and open it again."
                alert.addButton(withTitle: "Quit Flux")
                alert.runModal()
                NSApplication.shared.terminate(nil)
                return
            }
            self.webView.configuration.userContentController.add(list)
            self.webView.load(URLRequest(url: URL(string: "flux-app://app/index.html")!))
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true && url?.scheme == "flux-app" && url?.host == "app" ? .allow : .cancel)
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
    func chooseFiles() {
        Task {
            do { if let records = try await handle("selectFiles", nil) as? [[String: Any]] { emit("files", records) } }
            catch { emit("update", ["bridgeError": error.localizedDescription]) }
        }
    }
    private func handle(_ method: String, _ args: Any?) async throws -> Any {
        switch method {
        case "getState", "refreshEngines": return state()
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
        case "openSupport": NSWorkspace.shared.open(ReviewResources.supportURL); return true
        case "openPrivacy": NSWorkspace.shared.open(ReviewResources.privacyURL); return true
        case "selectOutput":
            guard !busy else { throw LocalError.invalid("Finish the current batch first.") }
            busy = true; defer { busy = false }
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true; panel.prompt = "Choose save folder"
            guard await present(panel) == .OK, let url = panel.url else { return outputLabel }
            if outputScoped { outputFolder?.stopAccessingSecurityScopedResource() }
            outputFolder = url; outputScoped = url.startAccessingSecurityScopedResource(); return outputLabel
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
            busy = true; cancelled = false
            Task { await run(jobs) }
            return true
        case "cancel": cancelled = true; control?.cancel(); return true
        case "reveal":
            guard !busy, let id = args as? String else { throw LocalError.invalid("Finish the current batch first.") }
            if let url = saved[id] { NSWorkspace.shared.activateFileViewerSelecting([url]); return true }
            guard let result = results[id] else { throw LocalError.invalid("This temporary result has been cleared. Convert the original again.") }
            try await save(result, id: id); return true
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
    private var outputLabel: String { outputFolder?.path ?? "Choose location when saving" }
    private func targets(_ ext: String) -> [String] { SharedMacEngine.targets(ext) }
    private var families: [[String: Any]] {
        SharedMacEngine.families
    }
    private func state() -> [String: Any] {
        ["nativeLocal": true, "fullEngine": true, "engines": ["local": true], "enginePaths": ["local": "Built into Flux · no downloads or server"], "outputDir": outputLabel,
         "history": history, "families": families, "running": busy, "files": [], "jobs": [],
         "samples": ReviewResources.samples.map { ["id": $0.id, "title": $0.title, "target": $0.target] },
         "privacyText": ReviewResources.privacyText, "supportText": ReviewResources.supportText,
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
                let size = try LocalPolicy.fileSize(url), ext = url.pathExtension.lowercased()
                let media = ["video", "audio"].contains(SharedMacEngine.descriptor(ext)["family"] as? String ?? "")
                guard size <= (media ? LocalPolicy.mediaLimit : SharedMacEngine.fileLimit) else { throw LocalError.invalid("Media is limited to 5 GB; other files to 1.9 GB.") }
                let family = families.first { ($0["formats"] as! [String]).contains(ext) }?["id"] as? String ?? "unsupported"
                let descriptor = SharedMacEngine.descriptor(ext)
                let compression = descriptor["compressionOptions"] as? [[String: Any]] ?? [["id": "archive", "name": "Lossless ZIP", "note": "Preserves the complete original file."]]
                records.append(["id": id, "path": id, "name": url.lastPathComponent, "ext": ext, "size": size, "family": family,
                    "targets": targets(ext), "compressionOptions": compression,
                    "notes": (descriptor["notes"] as? [String: String] ?? [:]).merging(["zip": "Preserves the original file in a ZIP."]) { first, _ in first }])
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
            let ext = source.pathExtension.lowercased()
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
            let name = job["outputName"] as? String ?? (operation == "pack" ? "Archive" : source.deletingPathExtension().lastPathComponent + "-converted")
            let token = JobControl(); control = token
            update["status"] = "running"; update["progress"] = 5; emit("update", update)
            do {
                let inputs = ids.compactMap { files[$0] }
                var request = job
                request["target"] = target
                let specification = request
                let result = try await Task.detached(priority: .userInitiated) { try await SharedMacEngine.convert(inputs: inputs, job: specification, name: name, control: token) }.value
                if token.isCancelled { result.remove(); throw LocalError.cancelled }
                let resultID = UUID().uuidString; results[resultID] = result
                let size = result.isDirectory ? Int64(0) : try LocalPolicy.fileSize(result.url)
                let record: [String: Any] = ["id": resultID, "name": result.url.lastPathComponent, "target": result.isDirectory ? "folder" : result.url.pathExtension, "size": size,
                    "operation": operation, "sourceName": source.lastPathComponent, "sourceFamily": families.first { ($0["formats"] as! [String]).contains(ext) }?["id"] ?? "unsupported",
                    "completedAt": Date().timeIntervalSince1970 * 1000, "saved": false, "savedBytes": ((try? LocalPolicy.fileSize(source)) ?? 0) - size]
                history.insert(record, at: 0); update["result"] = record; update["status"] = "done"; update["progress"] = 100
                while history.count > 100 {
                    let discarded = history.removeLast()
                    if let discardedID = discarded["id"] as? String {
                        results.removeValue(forKey: discardedID)?.remove()
                        saved.removeValue(forKey: discardedID)
                    }
                }
            } catch { update["status"] = cancelled ? "cancelled" : "error"; update["error"] = error.localizedDescription; update["progress"] = 0 }
            control = nil; emit("update", update)
        }
        busy = false; emit("update", ["batchComplete": true, "history": history])
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
    private func emit(_ event: String, _ value: Any) {
        guard JSONSerialization.isValidJSONObject(["event": event, "value": value]), let data = try? JSONSerialization.data(withJSONObject: ["event": event, "value": value]), let json = String(data: data, encoding: .utf8) else { return }
        webView.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('flux-native', {detail: payload}));", arguments: ["payload": json], in: nil, in: .page, completionHandler: nil)
    }
}

final class LocalDesktopWebView: WKWebView {
    var onFiles: (([URL]) -> Void)?
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) ? .copy : [] }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
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
