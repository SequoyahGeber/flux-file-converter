import Foundation
import ZIPFoundation

enum Archives {
    // ZIPFoundation's Sequence stops at an unreadable/encrypted entry. Check
    // the complete directory first so a partial extraction cannot look successful.
    static func declaredEntries(_ url: URL, control: JobControl) throws -> Int {
        let file = try FileHandle(forReadingFrom: url)
        defer { try? file.close() }
        let size = try file.seekToEnd()
        func read(_ offset: UInt64, _ count: Int) throws -> Data {
            guard offset <= size, UInt64(count) <= size - offset else { throw LocalError.invalid("Truncated ZIP directory.") }
            try file.seek(toOffset: offset)
            guard let data = try file.read(upToCount: count), data.count == count else { throw LocalError.invalid("Truncated ZIP directory.") }
            return data
        }
        func number(_ data: Data, _ offset: Int, _ count: Int) -> UInt64 {
            var value: UInt64 = 0
            for i in 0..<count { value |= UInt64(data[offset + i]) << (i * 8) }
            return value
        }
        guard size >= 22 else { throw LocalError.invalid("Invalid ZIP directory.") }
        let tailOffset = size - min(size, 65557), tail = try read(tailOffset, Int(size - tailOffset))
        var end: Int?
        for offset in stride(from: tail.count - 22, through: 0, by: -1) {
            if number(tail, offset, 4) == 0x06054b50, offset + 22 + Int(number(tail, offset + 20, 2)) == tail.count {
                end = offset; break
            }
        }
        guard let end, number(tail, end + 4, 2) == 0, number(tail, end + 6, 2) == 0,
              number(tail, end + 8, 2) == number(tail, end + 10, 2) else { throw LocalError.invalid("Invalid or multi-volume ZIP directory.") }
        var count = number(tail, end + 10, 2), directorySize = number(tail, end + 12, 4), start = number(tail, end + 16, 4)
        let endOffset = tailOffset + UInt64(end)
        if count == 0xffff || directorySize == 0xffffffff || start == 0xffffffff {
            guard endOffset >= 20 else { throw LocalError.invalid("Missing ZIP64 directory.") }
            let locator = try read(endOffset - 20, 20)
            guard number(locator, 0, 4) == 0x07064b50, number(locator, 4, 4) == 0, number(locator, 16, 4) == 1 else { throw LocalError.invalid("Invalid ZIP64 directory.") }
            let record = try read(number(locator, 8, 8), 56)
            guard number(record, 0, 4) == 0x06064b50, number(record, 4, 8) >= 44,
                  number(record, 16, 4) == 0, number(record, 20, 4) == 0,
                  number(record, 24, 8) == number(record, 32, 8) else { throw LocalError.invalid("Invalid ZIP64 directory.") }
            count = number(record, 32, 8); directorySize = number(record, 40, 8); start = number(record, 48, 8)
        }
        guard count <= 2000, start <= endOffset, directorySize <= endOffset - start else { throw LocalError.invalid("Invalid ZIP directory or archive exceeds 2,000 entries.") }
        let limit = start + directorySize
        var cursor = start
        for _ in 0..<Int(count) {
            try control.check()
            guard cursor <= limit, limit - cursor >= 46 else { throw LocalError.invalid("Truncated ZIP directory.") }
            let header = try read(cursor, 46)
            guard number(header, 0, 4) == 0x02014b50 else { throw LocalError.invalid("Invalid ZIP entry.") }
            guard number(header, 8, 2) & 0x41 == 0 else { throw LocalError.invalid("Encrypted ZIP files are not supported. Unlock the archive first.") }
            guard [0, 8].contains(number(header, 10, 2)) else { throw LocalError.invalid("This ZIP compression method is not supported.") }
            let system = number(header, 5, 1), mode = (number(header, 38, 4) >> 16) & 0xf000
            if system == 3 || system == 19 {
                guard [0, 0x8000, 0x4000].contains(mode) else { throw LocalError.invalid("Links and special files in ZIP archives are not supported.") }
            }
            let length = 46 + number(header, 28, 2) + number(header, 30, 2) + number(header, 32, 2)
            guard length <= limit - cursor else { throw LocalError.invalid("Truncated ZIP directory.") }
            cursor += length
        }
        guard cursor == limit else { throw LocalError.invalid("ZIP directory contains unsupported or inconsistent metadata.") }
        return Int(count)
    }
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
        let expected = try declaredEntries(archive.url, control: control)
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
        guard entries.count == expected else { throw LocalError.invalid("ZIP contains an unreadable entry. No partial result was extracted.") }
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
                try autoreleasepool {
                try control.check(); count += Int64(chunk.count); total += Int64(chunk.count)
                guard count <= entry.uncompressedSize, total <= LocalPolicy.expandedLimit else { throw LocalError.invalid("Archive expansion exceeds its declared size.") }
                try file.write(contentsOf: chunk)
                }
            }
            guard checksum == entry.checksum, count == entry.uncompressedSize else { throw LocalError.invalid("Archive checksum or size is incorrect.") }
        }
    }
    static func zip(_ inputs: [URL], names: [String], output: URL, compress: Bool, control: JobControl) throws {
        guard inputs.count == names.count, inputs.count <= 2000 else { throw LocalError.invalid("Archive exceeds 2,000 entries or has invalid names.") }
        var total: Int64 = 0
        for input in inputs {
            try control.check()
            let size = try LocalPolicy.fileSize(input)
            guard size <= LocalPolicy.expandedLimit - total else { throw LocalError.invalid("ZIP contents exceed the 1 GB extraction limit.") }
            total += size
        }
        let archive = try Archive(url: output, accessMode: .create)
        var seen = Set<String>()
        for (index, input) in inputs.enumerated() {
            try control.check()
            let name = try path(names[index])
            guard seen.insert(name.precomposedStringWithCanonicalMapping.lowercased()).inserted else { throw LocalError.invalid("Selected files have duplicate names. Rename them before making a ZIP.") }
            let size = try LocalPolicy.fileSize(input), handle = try FileHandle(forReadingFrom: input)
            defer { try? handle.close() }
            func add(_ method: CompressionMethod) throws {
                try archive.addEntry(with: name, type: .file, uncompressedSize: size, compressionMethod: method, bufferSize: 65536) { position, count in
                    try autoreleasepool {
                        try control.check(); try handle.seek(toOffset: UInt64(position))
                        return try handle.read(upToCount: count) ?? Data()
                    }
                }
            }
            try add(compress ? .deflate : .none)
            if compress, let entry = archive[name], entry.uncompressedSize / max(1, entry.compressedSize) > 200 {
                try control.check()
                try archive.remove(entry, bufferSize: 65536)
                try add(.none)
            }
        }
        _ = try validate(archive, control: control)
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
