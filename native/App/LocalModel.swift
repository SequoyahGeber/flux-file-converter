import Foundation
import SwiftUI
import OfflineKit

@MainActor final class LocalModel: ObservableObject {
    @Published var inputs: [URL] = []
    @Published var target = "png"
    @Published var filename = "Converted"
    @Published var options = ConversionOptions()
    @Published var busy = false
    @Published var result: LocalResult?
    @Published var message = ""
    @Published var error = ""
    private var control: JobControl?
    var formats: [String] { inputs.count > 1 ? ["zip"] : LocalFormats.outputs(for: inputs.first?.pathExtension.lowercased() ?? "") }
    var source: String { inputs.first?.pathExtension.lowercased() ?? "" }
    var media: Bool { LocalFormats.audio.contains(source) || LocalFormats.video.contains(source) }
    init() { OfflineEngine.clearTemporaryFiles() }
    func select(_ urls: [URL]) {
        guard !busy else { return }
        result?.remove(); result = nil; message = ""; error = ""
        guard urls.count <= 100 else { error = "Choose up to 100 files at a time."; return }
        inputs = Array(urls.prefix(100))
        filename = inputs.count == 1 ? inputs[0].deletingPathExtension().lastPathComponent + "-converted" : "Archive"
        target = formats.first ?? "zip"
        if inputs.count == 1, formats.contains("jpg"), source == "png" { target = "jpg" }
        if inputs.count == 1, media, formats.contains("mkv") { target = "mkv" }
    }
    func convert() {
        guard !busy, !inputs.isEmpty else { return }
        result?.remove(); result = nil; error = ""; message = "Converting on this device…"; busy = true
        let urls = inputs, target = target, filename = filename, options = options, job = JobControl()
        control = job
        Task {
            do {
                let converted = try await Task.detached(priority: .userInitiated) {
                    try await OfflineEngine.convert(inputs: urls, target: target, name: filename, options: options, control: job)
                }.value
                result = converted; message = "Ready to save."
            } catch { self.error = error.localizedDescription; message = "" }
            busy = false; control = nil
        }
    }
    func cancel() { control?.cancel(); message = "Cancelling…" }
    func configurationChanged() {
        guard !busy else { return }
        if media && !options.lossless && !["mp4", "mov", "m4a", "wav", "aiff", "caf", "zip"].contains(target) {
            target = LocalFormats.audio.contains(source) ? "m4a" : "mp4"
        }
        result?.remove(); result = nil; message = ""; error = ""
    }
    func renameResult() async throws -> LocalResult {
        guard let result else { throw LocalError.invalid("Convert a file first.") }
        let newName = result.isDirectory ? String(try LocalPolicy.safeName(filename, extension: "folder").dropLast(7)) : try LocalPolicy.safeName(filename, extension: result.url.pathExtension)
        if newName == result.url.lastPathComponent { return result }
        let destination = result.directory.appendingPathComponent(newName, isDirectory: result.isDirectory)
        let renamed = try await Task.detached {
            guard !FileManager.default.fileExists(atPath: destination.path) else { throw LocalError.invalid("This result name already exists. Choose a different name.") }
            try FileManager.default.moveItem(at: result.url, to: destination)
            return LocalResult(url: destination, directory: result.directory, note: result.note, isDirectory: result.isDirectory)
        }.value
        self.result = renamed; return renamed
    }
    func clear() {
        guard !busy else { return }
        result?.remove(); result = nil; inputs = []; message = ""; error = ""
    }
}
