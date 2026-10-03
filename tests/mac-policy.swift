import Foundation

@main
struct MacPolicyTests {
  static func main() throws {
    let domain = "https://fileconverter.sequoyahgeber.com"
    let valid = domain + "/api/download/" + UUID().uuidString
    assert(ClientPolicy.isDownload(URL(string: valid)))
    for url in [
      "http://fileconverter.sequoyahgeber.com/", domain + ".evil.test/",
      "https://fileconverter.sequoyahgeber.com@evil.test/",
      "https://evil.test@fileconverter.sequoyahgeber.com/", domain + ":443/",
      "file:///tmp/private", "javascript:alert(1)",
    ] {
      assert(!ClientPolicy.allowsNavigation(URL(string: url)), url)
    }
    for url in [
      domain + "/api/download/not-a-result",
      domain + "/api/download/" + UUID().uuidString + "/extra",
      "https://sequoyahgeber.cloudflareaccess.com/api/download/" + UUID().uuidString,
    ] {
      assert(!ClientPolicy.isDownload(URL(string: url)), url)
    }
    let invitation = domain + "/?invite=" + String(repeating: "a", count: 43)
    assert(ClientPolicy.invitation(invitation) != nil)
    assert(ClientPolicy.invitation(invitation + "&next=https://evil.test") == nil)
    assert(ClientPolicy.invitation(invitation + "#fragment") == nil)
    assert(ClientPolicy.invitation(domain + "/?invite=short") == nil)
    let rulesData = try ClientPolicy.resourceRules().data(using: .utf8)!
    let rules = try JSONSerialization.jsonObject(with: rulesData) as! [[String: Any]]
    assert(rules.count == 5)
    assert((rules[0]["action"] as? [String: String])?["type"] == "block")
    assert(!ClientPolicy.allowsNavigation(URL(string: "https://challenges.cloudflare.com/")))
    assert(ClientPolicy.allowsChallengeFrame(URL(string: "https://challenges.cloudflare.com/")))
    assert(
      !ClientPolicy.allowsChallengeFrame(
        URL(string: "https://challenges.cloudflare.com.evil.test/")))
    assert(ClientPolicy.filename("../../payload.sh") == "Converted file")
    assert(ClientPolicy.filename("My converted image.jpg") == "My converted image.jpg")
    assert(ClientPolicy.validRename("Holiday photo.jpg", original: "sample.jpg"))
    assert(!ClientPolicy.validRename("../sample.jpg", original: "sample.jpg"))
    assert(!ClientPolicy.validRename("sample.exe", original: "sample.jpg"))
    assert(!ClientPolicy.validRename("sample.jpg\n", original: "sample.jpg"))
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }
    let source = root.appendingPathComponent("source")
    let destination = root.appendingPathComponent("user-file")
    try Data("old user content".utf8).write(to: destination)
    do {
      try SafeSave.commit(root.appendingPathComponent("missing"), to: destination)
      fatalError("A missing source must fail")
    } catch {
      let original = try String(contentsOf: destination, encoding: .utf8)
      assert(original == "old user content")
    }
    try Data("converted content".utf8).write(to: source)
    try SafeSave.commit(source, to: destination)
    let replaced = try String(contentsOf: destination, encoding: .utf8)
    assert(replaced == "converted content")
    let newFile = root.appendingPathComponent("new-file")
    try SafeSave.commit(source, to: newFile)
    let created = try String(contentsOf: newFile, encoding: .utf8)
    assert(created == "converted content")
    assert(fm.fileExists(atPath: source.path))
    print("Mac client policy and safe-save checks passed")
  }
}
