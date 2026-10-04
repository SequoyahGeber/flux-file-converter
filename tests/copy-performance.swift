import Foundation
@main
struct CopyAudit {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("flux-copy-benchmark-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("source.bin"), output = root.appendingPathComponent("output.bin")
        FileManager.default.createFile(atPath: source.path, contents: nil)
        let file = try FileHandle(forWritingTo: source)
        try file.truncate(atOffset: 512 * 1024 * 1024)
        try file.close()
        let start = ProcessInfo.processInfo.systemUptime
        try LocalPolicy.copy(source, to: output, control: JobControl())
        guard try LocalPolicy.fileSize(output) == 512 * 1024 * 1024 else { throw LocalError.invalid("Size mismatch") }
        print("512 MiB streaming copy: \(ProcessInfo.processInfo.systemUptime - start) seconds")
    }
}
