import Foundation

@main
struct MacPolicyTests {
  static func main() throws {
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
    print("Atomic safe-save checks passed")
  }
}
