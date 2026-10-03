import Foundation

enum ClientPolicy {
  static let origin: URL = {
    #if DEBUG
      // Loopback fixtures are available only in development binaries, never TestFlight.
      if let argument = ProcessInfo.processInfo.arguments.first(where: {
        $0.hasPrefix("--test-origin=")
      }),
        let url = URL(string: String(argument.dropFirst("--test-origin=".count))),
        url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
        url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil,
        url.fragment == nil
      {
        return url
      }
    #endif
    return URL(string: "https://fileconverter.sequoyahgeber.com")!
  }()
  static let loginHost = "sequoyahgeber.cloudflareaccess.com"
  static let challengeHost = "challenges.cloudflare.com"
  static let maxDownloadBytes: Int64 = 5 * 1024 * 1024 * 1024
  static let maxDownloads = 2
  static let downloadTimeout: TimeInterval = 600

  static func isWorkspace(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
      && url.user == nil && url.password == nil
  }

  static func allowsNavigation(_ url: URL?) -> Bool {
    guard let url else { return false }
    return isWorkspace(url)
      || (url.scheme == "https" && url.host == loginHost
        && url.port == nil && url.user == nil && url.password == nil)
  }

  static func allowsChallengeFrame(_ url: URL?) -> Bool {
    guard let url else { return false }
    return url.scheme == "https" && url.host == challengeHost && url.port == nil
      && url.user == nil && url.password == nil
  }

  static func resourceRules() throws -> String {
    let origins = [origin.absoluteString, "https://" + loginHost, "https://" + challengeHost]
      .map { "^" + NSRegularExpression.escapedPattern(for: $0) + "/" }
    let rules: [[String: Any]] =
      [
        ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
        ["trigger": ["url-filter": "^data:image/"], "action": ["type": "ignore-previous-rules"]],
      ]
      + origins.map {
        ["trigger": ["url-filter": $0], "action": ["type": "ignore-previous-rules"]]
      }
    return String(decoding: try JSONSerialization.data(withJSONObject: rules), as: UTF8.self)
  }

  static func isDownload(_ url: URL?) -> Bool {
    guard isWorkspace(url), let url else { return false }
    let parts = url.path.split(separator: "/")
    return parts.count == 3 && parts[0] == "api" && parts[1] == "download"
      && UUID(uuidString: String(parts[2])) != nil
  }

  static func invitation(_ text: String) -> URL? {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
      isWorkspace(url), url.path == "/", url.fragment == nil,
      let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
      items.count == 1, items[0].name == "invite", let token = items[0].value,
      token.count == 43,
      token.unicodeScalars.allSatisfy({
        CharacterSet(
          charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
        ).contains($0)
      })
    else { return nil }
    return url
  }

  static func filename(_ suggested: String) -> String {
    let cleaned = suggested.unicodeScalars.filter {
      !CharacterSet.controlCharacters.contains($0) && !"/\\:".unicodeScalars.contains($0)
    }.map(String.init).joined().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !cleaned.isEmpty, !cleaned.hasPrefix("."), !cleaned.hasPrefix("-"),
      cleaned.utf8.count <= 180
    else { return "Converted file" }
    return cleaned
  }

  static func validRename(_ name: String, original: String) -> Bool {
    !name.isEmpty && filename(name) == name
      && (name as NSString).pathExtension.lowercased()
        == (original as NSString).pathExtension.lowercased()
  }
}
