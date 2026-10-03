import Combine
import UIKit
import UniformTypeIdentifiers
import WebKit

struct MobileTransfer: Identifiable {
  let id: UUID
  let download: WKDownload
  var name: String
  var url: URL?
  var folder: URL?
  var active = true
  var exported = false
  var fraction = 0.0
  var detail = "Starting…"
  var timeout: Timer?
}

@MainActor
final class MobileClient: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate,
  WKDownloadDelegate, UIDocumentPickerDelegate
{
  let webView: WKWebView
  @Published var connected = false
  @Published var status = "Private server"
  @Published var error: String?
  @Published var showDownloads = false
  @Published var transfers: [MobileTransfer] = []
  @Published var choosingFiles = false
  private let cache: URL
  private var cacheReady = false
  private var rulesReady = false
  private var pendingConnection: URL?
  private var fileCompletion: (([URL]?) -> Void)?
  private var uploadScopes: [URL] = []
  private var timer: Timer?

  override init() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let origin = String(
      decoding: try! JSONEncoder().encode(ClientPolicy.origin.absoluteString), as: UTF8.self)
    configuration.userContentController.addUserScript(
      WKUserScript(
        source: """
          if (location.origin === \(origin)) {
              const help = document.getElementById('save-help');
              if (help) help.textContent = 'Save as downloads the result into Flux. Open Downloads to save it to Files or share it.';
          }
          """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    // No native message bridge, bundled file parsers, third-party SDKs or tracking.
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.allowsBackForwardNavigationGestures = false
    webView.isInspectable = false
    cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("FluxDownloads", isDirectory: true)
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    do {
      if FileManager.default.fileExists(atPath: cache.path) {
        try FileManager.default.removeItem(at: cache)
      }
      try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.complete], ofItemAtPath: cache.path)
      cacheReady = true
    } catch { self.error = "Flux could not create its private download cache." }
    do {
      WKContentRuleListStore.default().compileContentRuleList(
        forIdentifier: "FluxWorkspace-v1",
        encodedContentRuleList: try ClientPolicy.resourceRules()
      ) { [weak self] rules, failure in
        guard let self else { return }
        guard let rules, failure == nil else {
          self.error = "Flux could not enable its connection restrictions. Restart the app."
          self.pendingConnection = nil
          return
        }
        self.webView.configuration.userContentController.add(rules)
        self.rulesReady = true
        if let url = self.pendingConnection {
          self.pendingConnection = nil
          self.connect(url)
        }
      }
    } catch { self.error = "Flux could not enable its connection restrictions." }
  }

  func connect(_ url: URL = ClientPolicy.origin) {
    guard ClientPolicy.allowsNavigation(url) else { return }
    connected = true
    error = nil
    guard rulesReady else {
      pendingConnection = url
      return
    }
    webView.load(URLRequest(url: url))
  }
  func reload() {
    error = nil
    if webView.url != nil { webView.reload() } else { connect() }
  }
  func signOut() {
    cancelDownloads()
    releaseUploadScopes()
    connect(ClientPolicy.origin.appendingPathComponent("cdn-cgi/access/logout"))
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard
      ClientPolicy.allowsNavigation(action.request.url)
        || (action.targetFrame?.isMainFrame == false
          && ClientPolicy.allowsChallengeFrame(action.request.url))
    else {
      decisionHandler(.cancel)
      error = "Flux only opens its private workspace and Cloudflare sign-in."
      return
    }
    if action.shouldPerformDownload {
      decisionHandler(ClientPolicy.isDownload(action.request.url) ? .download : .cancel)
    } else if action.targetFrame == nil {
      decisionHandler(.cancel)
      webView.load(action.request)
    } else {
      decisionHandler(.allow)
    }
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    if !response.canShowMIMEType
      || (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?
        .hasPrefix("attachment") == true
    {
      decisionHandler(ClientPolicy.isDownload(response.response.url) ? .download : .cancel)
    } else {
      decisionHandler(
        (ClientPolicy.allowsNavigation(response.response.url)
          || (!response.isForMainFrame && ClientPolicy.allowsChallengeFrame(response.response.url)))
          ? .allow : .cancel)
    }
  }
  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    status = "Connecting…"
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    status = ClientPolicy.isWorkspace(webView.url) ? "Private server" : "Cloudflare sign-in · MFA"
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    navigationFailed(error)
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    navigationFailed(error)
  }
  private func navigationFailed(_ failure: Error) {
    guard (failure as NSError).code != NSURLErrorCancelled else { return }
    status = "Disconnected"
    error = "Could not connect securely. Check your connection and reconnect."
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    status = "Disconnected"
    error = "The workspace stopped responding. Reconnect to continue."
  }
  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    completionHandler(.performDefaultHandling, nil)
  }
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if ClientPolicy.allowsNavigation(navigationAction.request.url) {
      webView.load(navigationAction.request)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    guard frame.isMainFrame, ClientPolicy.isWorkspace(frame.request.url), fileCompletion == nil
    else {
      completionHandler(nil)
      return
    }
    fileCompletion = completionHandler
    choosingFiles = true
  }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL])
  {
    guard !urls.isEmpty, urls.count <= 30 else {
      error = "Choose up to 30 files."
      finishFileSelection(nil)
      return
    }
    releaseUploadScopes()
    for url in urls where url.startAccessingSecurityScopedResource() { uploadScopes.append(url) }
    finishFileSelection(urls)
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finishFileSelection(nil)
  }
  func finishFileSelection(_ urls: [URL]?) {
    let completion = fileCompletion
    fileCompletion = nil
    choosingFiles = false
    completion?(urls)
  }
  private func releaseUploadScopes() {
    for url in uploadScopes { url.stopAccessingSecurityScopedResource() }
    uploadScopes.removeAll()
  }

  func webView(
    _ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
  ) {
    download.delegate = self
  }
  func webView(
    _ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload
  ) {
    download.delegate = self
  }
  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse,
    suggestedFilename: String, completionHandler: @escaping (URL?) -> Void
  ) {
    guard cacheReady, ClientPolicy.isDownload(response.url),
      ClientPolicy.isDownload(download.originalRequest?.url),
      let http = response as? HTTPURLResponse, http.statusCode == 200,
      response.expectedContentLength >= 0,
      response.expectedContentLength <= ClientPolicy.maxDownloadBytes,
      transfers.filter({ $0.active || $0.url != nil }).count < ClientPolicy.maxDownloads
    else {
      error =
        "This result expired, exceeds 5 GB, or both download slots are occupied. Save or clear a result and retry."
      completionHandler(nil)
      return
    }
    do {
      let id = UUID()
      let folder = cache.appendingPathComponent(id.uuidString, isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let name = ClientPolicy.filename(suggestedFilename)
      let url = folder.appendingPathComponent(name)
      let timeout = Timer.scheduledTimer(
        withTimeInterval: ClientPolicy.downloadTimeout, repeats: false
      ) { [weak self] _ in
        Task { @MainActor in self?.cancel(id, detail: "Download exceeded 10 minutes. Try again.") }
      }
      transfers.append(
        MobileTransfer(
          id: id, download: download, name: name, url: url, folder: folder, timeout: timeout))
      if transfers.count > 50,
        let old = transfers.firstIndex(where: { !$0.active && $0.url == nil })
      {
        transfers.remove(at: old)
      }
      showDownloads = true
      beginProgress()
      completionHandler(url)
    } catch {
      self.error = "Flux could not start the download. Check available storage."
      completionHandler(nil)
    }
  }
  func download(
    _ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void
  ) {
    decisionHandler(ClientPolicy.isDownload(request.url) ? .allow : .cancel)
  }
  func download(
    _ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    completionHandler(.performDefaultHandling, nil)
  }
  func downloadDidFinish(_ download: WKDownload) {
    guard let index = transfers.firstIndex(where: { $0.download === download && $0.active }) else {
      return
    }
    transfers[index].timeout?.invalidate()
    transfers[index].active = false
    transfers[index].fraction = 1
    transfers[index].detail = "Ready to save"
  }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard let index = transfers.firstIndex(where: { $0.download === download && $0.active }) else {
      return
    }
    transfers[index].active = false
    transfers[index].detail = "Download failed. Save the result again from the workspace."
    dispose(index)
  }
  private func beginProgress() {
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.updateProgress() }
    }
  }
  private func updateProgress() {
    guard transfers.contains(where: \.active) else {
      timer?.invalidate()
      timer = nil
      return
    }
    for index in transfers.indices where transfers[index].active {
      let progress = transfers[index].download.progress
      if progress.completedUnitCount > ClientPolicy.maxDownloadBytes {
        cancel(transfers[index].id, detail: "Download exceeded 5 GB.")
        continue
      }
      transfers[index].fraction = min(1, max(0, progress.fractionCompleted))
      transfers[index].detail = ByteCountFormatter.string(
        fromByteCount: progress.completedUnitCount, countStyle: .file)
    }
  }
  func cancel(_ id: UUID, detail: String = "Cancelled") {
    guard let index = transfers.firstIndex(where: { $0.id == id && $0.active }) else { return }
    transfers[index].active = false
    transfers[index].detail = detail
    transfers[index].timeout?.invalidate()
    transfers[index].download.cancel { [weak self] _ in
      guard let self, let index = self.transfers.firstIndex(where: { $0.id == id }) else { return }
      self.dispose(index)
    }
  }
  func cancelDownloads() {
    for transfer in transfers where transfer.active {
      cancel(transfer.id, detail: "Interrupted. Save again while Flux is open.")
    }
  }
  func rename(_ id: UUID, to name: String) {
    guard let index = transfers.firstIndex(where: { $0.id == id && !$0.active }),
      let previous = transfers[index].url
    else { return }
    guard ClientPolicy.validRename(name, original: transfers[index].name) else {
      error = "Choose a filename without paths or control characters and keep its extension."
      return
    }
    let next = previous.deletingLastPathComponent().appendingPathComponent(name)
    guard next != previous else { return }
    do {
      try FileManager.default.moveItem(at: previous, to: next)
      transfers[index].url = next
      transfers[index].name = name
    } catch { self.error = "The result could not be renamed." }
  }
  func exported(_ id: UUID) {
    guard let index = transfers.firstIndex(where: { $0.id == id && !$0.active }) else { return }
    transfers[index].exported = true
    transfers[index].detail = "Saved to Files"
    dispose(index)
  }
  private func dispose(_ index: Int) {
    transfers[index].timeout?.invalidate()
    if let folder = transfers[index].folder { try? FileManager.default.removeItem(at: folder) }
    transfers[index].url = nil
    transfers[index].folder = nil
  }
  func clearFinished() {
    for index in transfers.indices where !transfers[index].active { dispose(index) }
    transfers.removeAll { !$0.active }
  }
}
