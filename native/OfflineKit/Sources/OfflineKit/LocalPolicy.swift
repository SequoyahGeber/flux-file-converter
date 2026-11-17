import Foundation
import Darwin

public enum LocalError: LocalizedError {
    /// `cancelled` is a deliberate stop (the person, or the app leaving the foreground); `timedOut` carries the
    /// job's deadline in seconds so the message states the limit that actually applied.
    case invalid(String), cancelled, timedOut(TimeInterval), unsupported
    public var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .cancelled: return "Conversion cancelled."
        case .timedOut(let limit): return "Stopped after \(LocalError.duration(limit)), the time limit for one conversion. Try a smaller file or a lossless option."
        case .unsupported: return "This conversion is not supported on this device. Try another output format."
        }
    }
    /// "10 minutes", "2 hours 10 minutes".
    static func duration(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int((seconds / 60).rounded())), hours = minutes / 60, rest = minutes % 60
        func unit(_ n: Int, _ name: String) -> String { "\(n) \(name)\(n == 1 ? "" : "s")" }
        if hours == 0 { return unit(minutes, "minute") }
        return rest == 0 ? unit(hours, "hour") : unit(hours, "hour") + " " + unit(rest, "minute")
    }
}

public final class JobControl: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private let started = ProcessInfo.processInfo.systemUptime
    private let deadline: TimeInterval
    /// On-device jobs default to ten minutes; the full Mac engine allows long media.
    public init(deadline: TimeInterval = 600) { self.deadline = deadline }
    public func cancel() { lock.lock(); stopped = true; lock.unlock() }
    public var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return stopped || ProcessInfo.processInfo.systemUptime - started > deadline
    }
    /// True only when the job was stopped with `cancel()`, not by its deadline.
    public var wasCancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    /// Throws `cancelled` after `cancel()`, or `timedOut` once the deadline has passed.
    public func check() throws {
        guard isCancelled else { return }
        throw wasCancelled ? LocalError.cancelled : LocalError.timedOut(deadline)
    }
}

public enum LocalPolicy {
    public static let mediaLimit: Int64 = 5 * 1024 * 1024 * 1024
    public static let fileLimit: Int64 = 512 * 1024 * 1024
    public static let textLimit = 16 * 1024 * 1024
    public static let expandedLimit: Int64 = 1024 * 1024 * 1024
    /// Output names (before the extension) are at most this many UTF-8 bytes.
    public static let nameByteLimit = 180
    /// Checks a name the person typed and returns the one rule it breaks, or nil when it is fine. Typed names are
    /// never changed silently; derived names go through `suggestedName` instead (FX-A-09).
    public static func nameProblem(_ name: String) -> String? {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return "Enter a file name." }
        if value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) {
            return "File names can’t contain line breaks or other control characters."
        }
        if value.contains("/") || value.contains("\\") || value.contains(":") { return "File names can’t contain /, \\ or :." }
        if value.hasPrefix(".") { return "File names can’t start with a dot." }
        if value.utf8.count > nameByteLimit { return "This name is too long. Use up to 180 letters (fewer in some languages)." }
        return nil
    }
    public static func safeName(_ name: String, extension ext: String) throws -> String {
        if let problem = nameProblem(name) { throw LocalError.invalid(problem) }
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = "." + ext
        return value.lowercased().hasSuffix(suffix) ? value : value + suffix
    }
    /// A name Flux derives from a file's name, such as the default output name, always passes `safeName`, so an
    /// ordinary file ("Report 1/2.pdf" in Finder, ".notes.txt", a long CJK name) never fails a rule the person
    /// didn't break (FX-A-09). `:`, `/` and `\` become "-", control characters and leading dots go, and the
    /// name is shortened on a character boundary so `suffix` still fits.
    public static func suggestedName(from name: String, suffix: String = "", fallback: String = "Converted") -> String {
        var value = String(String.UnicodeScalarView(name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
        for separator in [":", "/", "\\"] { value = value.replacingOccurrences(of: separator, with: "-") }
        value = value.trimmingCharacters(in: .whitespaces)
        while value.hasPrefix(".") { value.removeFirst() }
        value = truncated(value.trimmingCharacters(in: .whitespaces), toBytes: max(0, nameByteLimit - suffix.utf8.count))
            .trimmingCharacters(in: .whitespaces)
        return value.isEmpty ? fallback : value + suffix
    }
    /// The default output name for a source file: its name without the extension, plus "-converted".
    public static func defaultOutputName(for source: URL) -> String {
        suggestedName(from: source.deletingPathExtension().lastPathComponent, suffix: "-converted")
    }
    /// The longest prefix of whole characters that fits in `bytes` UTF-8 bytes.
    static func truncated(_ value: String, toBytes bytes: Int) -> String {
        guard value.utf8.count > bytes else { return value }
        var result = "", used = 0
        for character in value {
            let size = character.utf8.count
            guard used + size <= bytes else { break }
            result.append(character); used += size
        }
        return result
    }
    /// `name` if `isTaken` says it is free, otherwise "name 2.ext", "name 3.ext" and so on: used for ZIP entries and
    /// Save All, which never overwrite. A leading dot is part of the name, not an extension.
    public static func uniqueName(_ name: String, isDirectory: Bool = false, isTaken: (String) -> Bool) -> String {
        guard isTaken(name) else { return name }
        let dot = isDirectory ? nil : name.lastIndex(of: ".").flatMap { $0 == name.startIndex ? nil : $0 }
        let stem = dot.map { String(name[..<$0]) } ?? name, ext = dot.map { String(name[$0...]) } ?? ""
        var number = 2
        while isTaken("\(stem) \(number)\(ext)") { number += 1 }
        return "\(stem) \(number)\(ext)"
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
        try copy(source, to: destination, control: control) { descriptor, destination in
            fclonefileat(descriptor, AT_FDCWD, destination.path, 0)
        }
    }
    // Per-call seam keeps filesystem failure and file-change tests deterministic.
    // A successful operation must create a new destination, just like fclonefileat.
    static func copy(_ source: URL, to destination: URL, control: JobControl,
                     clone: (Int32, URL) throws -> Int32) throws {
        let descriptor = open(source.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let input = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? input.close() }
        var attributes = stat()
        guard fstat(descriptor, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFREG else {
            throw LocalError.invalid("Choose a regular file. Symbolic links and folders are not accepted.")
        }
        let expected = attributes.st_size
        try control.check()
        // Clone from the validated descriptor, never by reopening the source path.
        // APFS snapshots the bytes independently of later edits to either file.
        // Like streaming failures, clone validation failures leave the new file
        // for the caller's private job-folder cleanup; never unlink by pathname.
        if try clone(descriptor, destination) == 0 {
            let clonedDescriptor = open(destination.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
            guard clonedDescriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            defer { close(clonedDescriptor) }
            var cloned = stat()
            guard fstat(clonedDescriptor, &cloned) == 0, cloned.st_mode & S_IFMT == S_IFREG else {
                throw LocalError.invalid("The staged input is not a regular file.")
            }
            // Cloning inherits source metadata; staging must retain mode 0600.
            guard fchmod(clonedDescriptor, 0o600) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            guard cloned.st_size == expected else {
                throw LocalError.invalid("The selected file changed while it was being copied.")
            }
            try control.check()
            return
        }
        // Unsupported, cross-volume and other clone errors all retain the
        // exclusive streaming path. A pre-existing destination still fails O_EXCL.
        let outputDescriptor = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard outputDescriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let output = FileHandle(fileDescriptor: outputDescriptor, closeOnDealloc: true)
        defer { try? output.close() }
        var copied: Int64 = 0
        // FileHandle bridges through autoreleased Foundation buffers. Background
        // conversion tasks need a pool per chunk to keep large copies bounded.
        while try autoreleasepool(invoking: { () throws -> Bool in
            try control.check()
            guard let chunk = try input.read(upToCount: 1024 * 1024), !chunk.isEmpty else { return false }
            copied += Int64(chunk.count)
            guard copied <= expected else { throw LocalError.invalid("The selected file grew while it was being copied.") }
            try output.write(contentsOf: chunk)
            return true
        }) {}
        guard copied == expected else { throw LocalError.invalid("The selected file changed while it was being copied.") }
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
    /// Renames the result inside its job folder. `name` must already have passed `LocalPolicy.safeName`. A
    /// change of case only ("A-converted.jpg" to "a-converted.jpg") works on a case-insensitive volume, where the
    /// new name already "exists" because it is the same file (FX-A-09).
    public func renamed(to name: String) throws -> LocalResult {
        if name == url.lastPathComponent { return self }
        let destination = directory.appendingPathComponent(name, isDirectory: isDirectory)
        if FileManager.default.fileExists(atPath: destination.path), !Self.isSameItem(url, destination) {
            throw LocalError.invalid("This result name already exists. Choose a different name.")
        }
        // rename(2) handles the case-only change that FileManager.moveItem refuses.
        guard Darwin.rename(url.path, destination.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        return LocalResult(url: destination, directory: directory, note: note, isDirectory: isDirectory)
    }
    static func isSameItem(_ first: URL, _ second: URL) -> Bool {
        let key: Set<URLResourceKey> = [.fileResourceIdentifierKey]
        guard let a = try? first.resourceValues(forKeys: key).fileResourceIdentifier,
              let b = try? second.resourceValues(forKeys: key).fileResourceIdentifier else { return false }
        return a.isEqual(b)
    }
}
