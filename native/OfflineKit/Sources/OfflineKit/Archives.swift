import Foundation
import ZIPFoundation

enum Archives {
    static func path(_ path: String) throws -> String {
        let value = path.hasSuffix("/") ? String(path.dropLast()) : path
        let pieces = value.split(separator: "/", omittingEmptySubsequences: false)
        guard !value.isEmpty, value.utf8.count <= 512, pieces.count <= 32,
              !value.contains("\\"), !value.contains(":"),
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              pieces.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw LocalError.invalid("Archive contains an unsafe path.")
        }
        return value
    }
    static func validate(_ archive: Archive, control: JobControl) throws -> [Entry] {
        var entries: [Entry] = [], names = Set<String>(), size: Int64 = 0
        for entry in archive {
            try control.check()
            if entries.count >= 2000 { throw LocalError.invalid("Archive exceeds 2,000 entries.") }
            let name = try path(entry.path).precomposedStringWithCanonicalMapping.lowercased()
            guard entry.type != .symlink, names.insert(name).inserted else { throw LocalError.invalid("Archive contains a symbolic link or duplicate path.") }
            guard entry.uncompressedSize <= UInt64(LocalPolicy.expandedLimit),
                  entry.compressedSize > 0 || entry.uncompressedSize == 0,
                  entry.uncompressedSize / max(1, entry.compressedSize) <= 200 else {
                throw LocalError.invalid("Archive expansion ratio exceeds the safety limit.")
            }
            size += Int64(entry.uncompressedSize)
            if size > LocalPolicy.expandedLimit { throw LocalError.invalid("Extracted archive exceeds 1 GB.") }
            entries.append(entry)
        }
        return entries
    }
    static func extract(_ input: URL, to directory: URL, control: JobControl) throws {
        let archive = try Archive(url: input, accessMode: .read)
        let entries = try validate(archive, control: control)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var total: Int64 = 0
        for entry in entries {
            try control.check()
            let destination = directory.appendingPathComponent(try path(entry.path))
            if entry.type == .directory {
                try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]); continue
            }
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            guard !FileManager.default.fileExists(atPath: destination.path) else { throw LocalError.invalid("Archive paths conflict.") }
            FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600])
            let file = try FileHandle(forWritingTo: destination)
            defer { try? file.close() }
            var count: Int64 = 0
            let checksum = try archive.extract(entry, bufferSize: 65536) { chunk in
                try control.check(); count += Int64(chunk.count); total += Int64(chunk.count)
                guard count <= entry.uncompressedSize, total <= LocalPolicy.expandedLimit else { throw LocalError.invalid("Archive expansion exceeds its declared size.") }
                try file.write(contentsOf: chunk)
            }
            guard checksum == entry.checksum, count == entry.uncompressedSize else { throw LocalError.invalid("Archive checksum or size is incorrect.") }
        }
    }
    static func zip(_ inputs: [URL], names: [String], output: URL, compress: Bool, control: JobControl) throws {
        let archive = try Archive(url: output, accessMode: .create)
        var seen = Set<String>()
        for (index, input) in inputs.enumerated() {
            try control.check()
            let name = try path(names[index])
            guard seen.insert(name.precomposedStringWithCanonicalMapping.lowercased()).inserted else { throw LocalError.invalid("Selected files have duplicate names. Rename them before making a ZIP.") }
            let size = try LocalPolicy.fileSize(input), handle = try FileHandle(forReadingFrom: input)
            defer { try? handle.close() }
            try archive.addEntry(with: name, type: .file, uncompressedSize: size, compressionMethod: compress ? .deflate : .none, bufferSize: 65536) { position, count in
                try control.check(); try handle.seek(toOffset: UInt64(position))
                return try handle.read(upToCount: count) ?? Data()
            }
        }
    }
    static func read(_ name: String, archive: Archive, control: JobControl) throws -> Data {
        guard let entry = archive[name], entry.type == .file, entry.uncompressedSize <= LocalPolicy.textLimit else { throw LocalError.invalid("Document component is missing or exceeds 16 MB.") }
        var data = Data()
        let checksum = try archive.extract(entry, bufferSize: 65536) { chunk in
            try control.check()
            guard data.count + chunk.count <= LocalPolicy.textLimit else { throw LocalError.invalid("Document expands beyond 16 MB.") }
            data.append(chunk)
        }
        guard checksum == entry.checksum, data.count == entry.uncompressedSize else { throw LocalError.invalid("Document component checksum is incorrect.") }
        return data
    }
    static func add(_ text: String, name: String, archive: Archive, compressed: Bool = true) throws {
        let data = Data(text.utf8)
        try archive.addEntry(with: name, type: .file, uncompressedSize: Int64(data.count), compressionMethod: compressed ? .deflate : .none) { position, size in
            let start = Int(position); return data.subdata(in: start..<min(data.count, start + size))
        }
    }
}
