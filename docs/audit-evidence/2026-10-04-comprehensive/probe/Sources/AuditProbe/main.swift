import Foundation
import OfflineKit
let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["FLUX_AUDIT_ROOT"] ?? "/tmp/flux-comprehensive-audit-20261004")
func probe(_ name: String, _ target: String) async {
 do {
  let result = try await OfflineEngine.convert(inputs: [root.appendingPathComponent(name)], target: target, name: name + "-audit", options: ConversionOptions())
  defer { result.remove() }
  let dest = root.appendingPathComponent(name + "." + target)
  try? FileManager.default.removeItem(at: dest)
  try FileManager.default.copyItem(at: result.url, to: dest)
  print("CONVERT \(name) -> \(target): SUCCESS")
  if ["srt", "txt", "csv", "html"].contains(target) { print(String(data: try Data(contentsOf: dest), encoding: .utf8) ?? "binary") }
 } catch { print("CONVERT \(name) -> \(target): ERROR \(error.localizedDescription)") }
}
await probe("short.vtt", "srt")
await probe("hours.vtt", "srt")
await probe("ordered.epub", "txt")
await probe("equation.docx", "html")
await probe("equation.docx", "pdf")
await probe("precise.json", "csv")
do {
 let zipped = try await OfflineEngine.convert(inputs: [root.appendingPathComponent("repeat.txt")], target: "zip", name: "repeat", options: ConversionOptions())
 defer { zipped.remove() }
 print("ZIP CREATION: SUCCESS size \(try LocalPolicy.fileSize(zipped.url))")
 do {
  let extracted = try await OfflineEngine.convert(inputs: [zipped.url], target: "unzip", name: "expanded", options: ConversionOptions())
  defer { extracted.remove() }; print("ZIP EXTRACTION: SUCCESS")
 } catch { print("ZIP EXTRACTION: ERROR \(error.localizedDescription)") }
 var storedOptions = ConversionOptions(); storedOptions.compressArchive = false
 let stored = try await OfflineEngine.convert(inputs: [root.appendingPathComponent("repeat.txt")], target: "zip", name: "stored", options: storedOptions)
 defer { stored.remove() }
 let extracted = try await OfflineEngine.convert(inputs: [stored.url], target: "unzip", name: "stored-expanded", options: ConversionOptions())
 defer { extracted.remove() }; print("STORED ZIP EXTRACTION: SUCCESS")
} catch { print("ZIP PROBE ERROR: \(error.localizedDescription)") }
