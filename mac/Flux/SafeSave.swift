import Foundation

enum SafeSave {
  // Build a replacement on the destination volume. A failed download never truncates an
  // existing user file, and a large result never needs to be held in memory.
  static func commit(_ downloaded: URL, to destination: URL) throws {
    let fm = FileManager.default
    let directory = try fm.url(
      for: .itemReplacementDirectory, in: .userDomainMask,
      appropriateFor: destination, create: true)
    defer { try? fm.removeItem(at: directory) }
    let replacement = directory.appendingPathComponent("result")
    try fm.copyItem(at: downloaded, to: replacement)
    if fm.fileExists(atPath: destination.path) {
      _ = try fm.replaceItemAt(destination, withItemAt: replacement)
    } else {
      try fm.moveItem(at: replacement, to: destination)
    }
  }
}
