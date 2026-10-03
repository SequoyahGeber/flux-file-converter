import Foundation

public enum OfflineEngine {
    public static var jobsDirectory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("FluxLocalJobs", isDirectory: true)
    }
    public static func clearTemporaryFiles() {
        try? FileManager.default.removeItem(at: jobsDirectory)
    }
    public static func convert(inputs: [URL], target: String, name: String, options: ConversionOptions,
                               control: JobControl = JobControl()) async throws -> LocalResult {
        guard !inputs.isEmpty, inputs.count <= 100, target == "zip" || inputs.count == 1 else {
            throw LocalError.invalid("Choose one file to convert, or up to 100 files to package as ZIP.")
        }
        let ext = inputs[0].pathExtension.lowercased()
        guard LocalFormats.outputs(for: ext).contains(target) else { throw LocalError.unsupported }
        let fm = FileManager.default, directory = jobsDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let inputDirectory = directory.appendingPathComponent("inputs", isDirectory: true)
        try fm.createDirectory(at: inputDirectory, withIntermediateDirectories: false)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var mutable = directory; try mutable.setResourceValues(values)
        do {
            var staged: [URL] = [], names: [String] = [], total: Int64 = 0
            for (index, source) in inputs.enumerated() {
                try control.check()
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                let sourceExt = source.pathExtension.lowercased()
                let size = try LocalPolicy.fileSize(source)
                let limit = LocalFormats.video.contains(sourceExt) || LocalFormats.audio.contains(sourceExt) ? LocalPolicy.mediaLimit : LocalPolicy.fileLimit
                guard size <= limit else { throw LocalError.invalid("Media is limited to 5 GB per file; other files to 512 MB.") }
                total += size
                guard total <= LocalPolicy.mediaLimit else { throw LocalError.invalid("Selected files exceed 5 GB in total.") }
                let available = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
                guard available > size + min(max(size, 64 * 1024 * 1024), 6 * 1024 * 1024 * 1024) else { throw LocalError.invalid("There is not enough free device storage for the input and result.") }
                let stagedExtension = sourceExt.count <= 12 && sourceExt.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) ? sourceExt : "bin"
                let copy = inputDirectory.appendingPathComponent("input-\(index).\(stagedExtension.isEmpty ? "bin" : stagedExtension)")
                try LocalPolicy.copy(source, to: copy, control: control)
                guard try LocalPolicy.fileSize(copy) == size else { throw LocalError.invalid("The selected file changed while it was being copied.") }
                staged.append(copy); names.append(source.lastPathComponent)
            }
            let filename = target == "unzip" ? try LocalPolicy.safeName(name, extension: "folder").dropLast(7).description : try LocalPolicy.safeName(name, extension: target)
            let output = directory.appendingPathComponent(filename)
            if target == "zip" { try Archives.zip(staged, names: names, output: output, compress: options.compressArchive, control: control) }
            else if target == "unzip" { try Archives.extract(staged[0], to: output, control: control) }
            else if LocalFormats.images.contains(ext) || ext == "pdf" { try ImagesPDF.convert(staged[0], output: output, target: target, options: options, control: control) }
            else if LocalFormats.video.contains(ext) || LocalFormats.audio.contains(ext) { try await Media.convert(staged[0], output: output, target: target, options: options, control: control) }
            else if LocalFormats.data.contains(ext) { try StructuredData.convert(staged[0], output: output, target: target, control: control) }
            else if LocalFormats.documents.contains(ext) { try Documents.convert(staged[0], output: output, target: target, control: control) }
            else if ["srt", "vtt"].contains(ext) { try Documents.subtitles(staged[0], output: output, target: target) }
            else { throw LocalError.unsupported }
            try control.check()
            if target != "unzip", try LocalPolicy.fileSize(output) > 6 * 1024 * 1024 * 1024 { throw LocalError.invalid("Output exceeds 6 GB.") }
            try fm.removeItem(at: inputDirectory)
            return LocalResult(url: output, directory: directory, note: LocalFormats.note(source: ext, target: target, lossless: options.lossless), isDirectory: target == "unzip")
        } catch { try? fm.removeItem(at: directory); throw error }
    }
}
