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
    let folder = root.appendingPathComponent("source-folder")
    try fm.createDirectory(at: folder, withIntermediateDirectories: false)
    try Data("nested".utf8).write(to: folder.appendingPathComponent("data"))
    let exported = root.appendingPathComponent("saved-folder")
    try SafeSave.commit(folder, to: exported, replaceExisting: false)
    do {
      try SafeSave.commit(folder, to: exported, replaceExisting: false)
      fatalError("An existing folder must never be replaced")
    } catch {
      let preserved = try String(contentsOf: exported.appendingPathComponent("data"), encoding: .utf8)
      assert(preserved == "nested")
    }
    assert(fm.fileExists(atPath: folder.path))
    print("Atomic safe-save checks passed")
  }
}
