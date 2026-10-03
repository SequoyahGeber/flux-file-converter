import AppKit
import Combine
import UniformTypeIdentifiers
import WebKit

struct Transfer: Identifiable {
  let id: ObjectIdentifier
  let download: WKDownload
  var name: String
  var destination: URL
  var temporary: URL?
  var savedURL: URL?
  var active = true
  var saving = false
  var busy: Bool { active || saving }
  var fraction = 0.0
  var detail = "Starting…"
  var timeout: Timer?
  var scopeActive = false
}

@MainActor
final class ClientModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate,
  WKDownloadDelegate
{
  let webView: WKWebView
  @Published var connected = false
  @Published var inWorkspace = false
  @Published var status = "Private server"
  @Published var error: String?
  @Published var showPrivacy = false
  @Published var showInvitation = false
  @Published var showDownloads = false
  @Published var transfers: [Transfer] = []
  private let cache: URL
  private var cacheReady = false
  private var timer: Timer?
  private var decidingDestination = false
  private var rulesReady = false
  private var pendingConnection: URL?

  override init() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let quotedOrigin = String(
      decoding: try! JSONEncoder().encode(ClientPolicy.origin.absoluteString), as: UTF8.self)
    configuration.userContentController.addUserScript(
      WKUserScript(
        source: """
          if (location.origin === \(quotedOrigin)) {
              const help = document.getElementById('save-help');
              if (help) help.textContent = 'Save as opens a Mac dialog to choose your filename and folder. Downloads appear in the native sidebar.';
          }
          """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    // There is deliberately no JavaScript-to-native message handler.
    webView = WKWebView(frame: .zero, configuration: configuration)
    cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("FluxDownloads", isDirectory: true)
    super.init()
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = false
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
    do {
      // Only this app-owned staging directory is cleaned, never a selected user folder.
      if FileManager.default.fileExists(atPath: cache.path) {
        try FileManager.default.removeItem(at: cache)
      }
      try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
      cacheReady = true
    } catch { self.error = "The private download cache could not be created." }
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
  func chooseFiles() {
    guard ClientPolicy.isWorkspace(webView.url) else { return }
    webView.evaluateJavaScript("document.getElementById('files')?.click()", completionHandler: nil)
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
    inWorkspace = false
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    inWorkspace = ClientPolicy.isWorkspace(webView.url)
    status =
      inWorkspace
      ? "Private server · files expire after 30 minutes" : "Cloudflare sign-in · MFA required"
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
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    inWorkspace = false
    status = "Disconnected"
    error = "The workspace stopped responding. Reconnect to continue."
  }
  private func navigationFailed(_ failure: Error) {
    if (failure as NSError).code == NSURLErrorCancelled { return }
    inWorkspace = false
    status = "Disconnected"
    error = "Could not connect securely to Flux. Check your connection, then reconnect."
  }
  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    // Preserve platform TLS verification. Never accept a bad certificate.
    completionHandler(.performDefaultHandling, nil)
  }
  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
  ) {
    guard frame.isMainFrame, ClientPolicy.isWorkspace(frame.request.url) else {
      completionHandler(nil)
      return
    }
    let panel = NSOpenPanel()
    panel.title = "Choose files to send to your private Flux server"
    panel.message =
      "Selected files are uploaded for scanning and conversion. Originals stay on your Mac."
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.begin { response in
      completionHandler(response == .OK && panel.urls.count <= 30 ? panel.urls : nil)
    }
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
      transfers.filter { $0.busy || $0.temporary != nil }.count < ClientPolicy.maxDownloads,
      !decidingDestination
    else {
      error =
        "This download expired, exceeds 5 GB, or both download slots are occupied. Finish or clear an existing transfer and try again."
      completionHandler(nil)
      return
    }
    decidingDestination = true
    let name = ClientPolicy.filename(suggestedFilename)
    savePanel(name: name) { [weak self] destination in
      guard let self else {
        completionHandler(nil)
        return
      }
      self.decidingDestination = false
      guard let destination else {
        completionHandler(nil)
        return
      }
      let id = ObjectIdentifier(download)
      let temporary = self.cache.appendingPathComponent(UUID().uuidString)
      let timeout = Timer.scheduledTimer(
        withTimeInterval: ClientPolicy.downloadTimeout, repeats: false
      ) { [weak self] _ in
        Task { @MainActor in self?.cancel(id, detail: "Download exceeded 10 minutes. Try again.") }
      }
      self.transfers.append(
        Transfer(
          id: id, download: download, name: destination.lastPathComponent,
          destination: destination, temporary: temporary, timeout: timeout,
          scopeActive: destination.startAccessingSecurityScopedResource()))
      while self.transfers.count > 50, let expired = self.transfers.firstIndex(where: { !$0.busy })
      {
        self.dispose(expired)
        self.transfers.remove(at: expired)
      }
      self.showDownloads = true
      self.beginProgress()
      completionHandler(temporary)
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
    guard
      let index = transfers.firstIndex(where: { $0.id == ObjectIdentifier(download) && $0.active })
    else { return }
    transfers[index].timeout?.invalidate()
    transfers[index].active = false
    finishSave(index)
  }
  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard
      let index = transfers.firstIndex(where: { $0.id == ObjectIdentifier(download) && $0.active })
    else { return }
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
  func cancel(_ id: ObjectIdentifier, detail: String = "Cancelled") {
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
    for transfer in transfers where transfer.active { cancel(transfer.id) }
  }
  func retrySave(_ id: ObjectIdentifier) {
    guard
      let index = transfers.firstIndex(where: { $0.id == id && !$0.busy && $0.temporary != nil })
    else { return }
    savePanel(name: transfers[index].name) { [weak self] destination in
      guard let self, let destination,
        let index = self.transfers.firstIndex(where: { $0.id == id })
      else { return }
      if self.transfers[index].scopeActive {
        self.transfers[index].destination.stopAccessingSecurityScopedResource()
      }
      self.transfers[index].destination = destination
      self.transfers[index].name = destination.lastPathComponent
      self.transfers[index].scopeActive = destination.startAccessingSecurityScopedResource()
      self.finishSave(index)
    }
  }
  private func finishSave(_ index: Int) {
    guard let temporary = transfers[index].temporary, !transfers[index].saving else { return }
    let destination = transfers[index].destination
    let id = transfers[index].id
    transfers[index].saving = true
    transfers[index].detail = "Saving…"
    // Copying a multi-gigabyte result must not block the UI. Keep its sandbox
    // scope and staging file alive until the atomic save has finished.
    Task { [weak self] in
      let failure = await Task.detached(priority: .userInitiated) {
        do {
          try SafeSave.commit(temporary, to: destination)
          try? FileManager.default.removeItem(at: temporary)
          return false
        } catch { return true }
      }.value
      guard let self, let index = self.transfers.firstIndex(where: { $0.id == id }) else { return }
      self.transfers[index].saving = false
      if failure {
        self.transfers[index].detail = "Could not save here. Choose another location."
      } else {
        self.transfers[index].savedURL = destination
        self.transfers[index].detail = "Saved"
        self.transfers[index].temporary = nil
      }
    }
  }
  private func savePanel(name: String, completion: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.title = "Save converted file"
    panel.nameFieldStringValue = ClientPolicy.filename(name)
    panel.canCreateDirectories = true
    let ext = (name as NSString).pathExtension
    if !ext.isEmpty, let type = UTType(filenameExtension: ext) {
      panel.allowedContentTypes = [type]
      panel.allowsOtherFileTypes = false
    }
    panel.begin { response in completion(response == .OK ? panel.url : nil) }
  }
  private func dispose(_ index: Int) {
    transfers[index].timeout?.invalidate()
    if let temporary = transfers[index].temporary {
      try? FileManager.default.removeItem(at: temporary)
    }
    transfers[index].temporary = nil
    if transfers[index].scopeActive {
      transfers[index].destination.stopAccessingSecurityScopedResource()
    }
    transfers[index].scopeActive = false
  }
  func clearFinished() {
    for index in transfers.indices where !transfers[index].busy { dispose(index) }
    transfers.removeAll { !$0.busy }
  }
}
