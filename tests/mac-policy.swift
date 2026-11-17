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
    try outputFolderRestoreChecks(root)
    print("Output folder restore checks passed")
    quitPolicyChecks()
    textSizeChecks()
    saveAllChecks()
    print("Quit policy checks passed")
  }
}

/// The saved output folder: access starts before the folder is checked (the sandbox hides it until then),
/// and a folder that is missing for now is released without being kept or erased.
func outputFolderRestoreChecks(_ root: URL) throws {
  let folder = root.appendingPathComponent("chosen-folder")
  try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
  var accessing = false, stopped = 0
  let restored = OutputFolderRestore.restore(
    resolve: { folder },
    startAccess: { _ in accessing = true; return true },
    stopAccess: { _ in stopped += 1 },
    exists: { url in accessing && FileManager.default.fileExists(atPath: url.path) })
  assert(restored?.url == folder && restored?.scoped == true, "A sandboxed folder must be found once access has started")
  assert(stopped == 0)
  accessing = false
  let missing = OutputFolderRestore.restore(
    resolve: { root.appendingPathComponent("unmounted") },
    startAccess: { _ in accessing = true; return true },
    stopAccess: { _ in stopped += 1 },
    exists: { FileManager.default.fileExists(atPath: $0.path) })
  assert(missing == nil && stopped == 1, "A missing folder is released for this launch")
  assert(OutputFolderRestore.restore(resolve: { nil }, startAccess: { _ in true }, stopAccess: { _ in }, exists: { _ in true }) == nil)
}

/// FX-B-01: quitting asks only when it would lose something, and says what.
func quitPolicyChecks() {
  assert(QuitPolicy.prompt(running: false, unsaved: 0) == nil, "Nothing to lose: quit without asking")
  let one = QuitPolicy.prompt(running: false, unsaved: 1)
  assert(one?.title == "Quit with unsaved results?")
  assert(one?.message.hasPrefix("1 converted file hasn’t been saved.") == true)
  assert(one?.quit == "Quit" && one?.keep == "Keep Flux Open")
  assert(QuitPolicy.prompt(running: false, unsaved: 3)?.message.hasPrefix("3 converted files haven’t been saved.") == true)
  let running = QuitPolicy.prompt(running: true, unsaved: 0)
  assert(running?.title == "Quit while converting?" && running?.quit == "Stop Batch and Quit")
  assert(QuitPolicy.prompt(running: true, unsaved: 2)?.message.contains("2 converted files haven’t been saved") == true)
}

/// FX-B-12: the text size steps in tenths between 50 % and 200 % and is remembered; Actual Size forgets it.
func textSizeChecks() {
  let defaults = UserDefaults(suiteName: "flux-mac-policy-\(UUID().uuidString)")!
  let key = "appearance.textSize"
  assert(TextSize.restored(from: defaults, key: key) == 1, "Nothing saved: Actual Size")
  assert(TextSize.stepped(1, by: 1) == 1.1 && TextSize.stepped(1.1, by: -1) == 1)
  assert(TextSize.stepped(2, by: 1) == 2 && TextSize.stepped(0.5, by: -1) == 0.5, "Kept in range")
  assert(TextSize.clamped(1.04) == 1 && TextSize.clamped(.nan) == 1)
  TextSize.save(1.3, to: defaults, key: key)
  assert(TextSize.restored(from: defaults, key: key) == 1.3, "Remembered across launches")
  defaults.set(9.0, forKey: key)
  assert(TextSize.restored(from: defaults, key: key) == 2, "An unusable saved value is clamped")
  TextSize.save(1, to: defaults, key: key)
  assert(defaults.object(forKey: key) == nil, "Actual Size removes the setting")
}

/// FX-B-11: Save all says how many files went where, and names the ones it couldn't save.
func saveAllChecks() {
  assert(SaveAllPolicy.summary(saved: 1, failed: [], folder: "Flux") == "Saved 1 file to “Flux”.")
  assert(SaveAllPolicy.summary(saved: 3, failed: [], folder: "Out") == "Saved 3 files to “Out”.")
  assert(SaveAllPolicy.summary(saved: 2, failed: ["a.png"], folder: "Out") == "Saved 2 files to “Out”. Couldn’t save “a.png”. Try Save as… for it.")
  assert(SaveAllPolicy.summary(saved: 0, failed: ["a", "b", "c", "d", "e"], folder: "Out") == "Couldn’t save “a”, “b”, “c” and 2 more. Try Save as… for them.")
  assert(SaveAllPolicy.panelMessage(count: 2).hasPrefix("Choose a folder for 2 files."))
}

