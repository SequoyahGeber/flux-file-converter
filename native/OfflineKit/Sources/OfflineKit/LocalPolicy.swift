import Foundation

public enum LocalError: LocalizedError {
    case invalid(String), cancelled, unsupported
    public var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .cancelled: return "Conversion cancelled or exceeded the 10-minute limit."
        case .unsupported: return "This conversion is not supported on this device. Try another output format."
        }
    }
}

public final class JobControl: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private let started = ProcessInfo.processInfo.systemUptime
    public init() {}
    public func cancel() { lock.lock(); stopped = true; lock.unlock() }
    public var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped || ProcessInfo.processInfo.systemUptime - started > 600
    }
    public func check() throws { if isCancelled { throw LocalError.cancelled } }
}

public enum LocalPolicy {
    public static let mediaLimit: Int64 = 5 * 1024 * 1024 * 1024
    public static let fileLimit: Int64 = 512 * 1024 * 1024
    public static let textLimit = 16 * 1024 * 1024
    public static let expandedLimit: Int64 = 1024 * 1024 * 1024
    public static func safeName(_ name: String, extension ext: String) throws -> String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 180, value != ".", value != "..",
              !value.contains("/"), !value.contains("\\"), !value.contains(":"),
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !value.hasPrefix(".") else { throw LocalError.invalid("Enter a file name without slashes or control characters.") }
        let suffix = "." + ext
        return value.lowercased().hasSuffix(suffix) ? value : value + suffix
    }
    public static func fileSize(_ url: URL) throws -> Int64 {
        let values = try FileManager.default.attributesOfItem(atPath: url.path)
        guard values[.type] as? FileAttributeType == .typeRegular else {
            throw LocalError.invalid("Choose a regular file. Symbolic links and folders are not accepted.")
        }
        return (values[.size] as? NSNumber)?.int64Value ?? 0
    }
    public static func readText(_ url: URL) throws -> String {
        guard try fileSize(url) <= textLimit else { throw LocalError.invalid("Text and structured data are limited to 16 MB.") }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        if let text = String(data: data, encoding: .utf8) { return text }
        if data.starts(with: [0xff, 0xfe]) || data.starts(with: [0xfe, 0xff]),
           let text = String(data: data, encoding: .utf16) { return text }
        throw LocalError.invalid("This file is not UTF-8 or UTF-16 text.")
    }
    public static func copy(_ source: URL, to destination: URL, control: JobControl) throws {
        FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let input = try FileHandle(forReadingFrom: source), output = try FileHandle(forWritingTo: destination)
        defer { try? input.close(); try? output.close() }
        while true {
            try control.check()
            guard let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty else { break }
            try output.write(contentsOf: chunk)
        }
    }
}

public struct ConversionOptions: Sendable, Equatable {
    public var quality: Double = 0.85
    public var lossless = true
    public var compressArchive = true
    public init() {}
}

public struct LocalResult: Sendable {
    public let url: URL
    public let directory: URL
    public let note: String
    public let isDirectory: Bool
    public init(url: URL, directory: URL, note: String = "", isDirectory: Bool = false) { self.url = url; self.directory = directory; self.note = note; self.isDirectory = isDirectory }
    public func remove() { try? FileManager.default.removeItem(at: directory) }
}
