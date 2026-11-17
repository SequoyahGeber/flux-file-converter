import Foundation
import SwiftUI
import AVFoundation
import OfflineKit
import UIKit

@MainActor final class LocalModel: ObservableObject {
    @Published var inputs: [URL] = []
    @Published var target = "png"
    @Published var filename = "Converted"
    @Published var options = ConversionOptions()
    /// While a conversion runs the screen stays awake (FX-A-01); every way a job ends goes through here.
    @Published var busy = false {
        didSet {
            UIApplication.shared.isIdleTimerDisabled = busy
            if !busy { endBackgroundTime() }
        }
    }
    /// A new or renamed result starts unsaved; a successful save marks it saved.
    @Published var result: LocalResult? { didSet { if result?.url != oldValue?.url { resultSaved = false } } }
    @Published var resultSaved = false
    @Published var message = ""
    @Published var error = ""
    /// A neutral outcome that is not an error, such as "Conversion cancelled." (FX-B-04).
    @Published var notice = ""
    /// Why the running job was stopped, so a stop is never shown as a failure.
    enum StopReason { case person, background }
    private var stopReason: StopReason?
    private var backgroundedDuringJob = false
    private var control: JobControl?
    private var backgroundTime: UIBackgroundTaskIdentifier = .invalid
    /// The rule the typed output name breaks, shown under the field as it is typed (FX-B-10); nil when it is fine.
    var nameProblem: String? { inputs.isEmpty ? nil : LocalPolicy.nameProblem(filename) }
    var formats: [String] { inputs.count > 1 ? ["zip"] : LocalFormats.outputs(for: inputs.first?.pathExtension.lowercased() ?? "") }
    var source: String { inputs.first?.pathExtension.lowercased() ?? "" }
    var media: Bool { LocalFormats.audio.contains(source) || LocalFormats.video.contains(source) }
    init() {
        OfflineEngine.clearTemporaryFiles()
        OpenedFiles.clear()
        FluxDiagnostics.fileNames = { [weak self] in
            guard let self else { return [] }
            return self.inputs.map(\.lastPathComponent) + [self.filename] + (self.result.map { [$0.url.lastPathComponent] } ?? [])
        }
    }
    func selectSample(_ sample: ReviewResources.Sample) {
        guard !busy, let url = sample.url else { return }
        select([url]); target = sample.target
    }
    func select(_ urls: [URL]) {
        guard !busy else { return }
        guard urls.count <= 100 else { error = "Choose up to 100 files at a time."; return }
        result?.remove(); result = nil; message = ""; error = ""; notice = ""
        OpenedFiles.discard(inputs.filter { !urls.contains($0) })
        inputs = Array(urls.prefix(100))
        // A derived name always passes the name rules, whatever the file is called (FX-A-09).
        filename = inputs.count == 1 ? LocalPolicy.defaultOutputName(for: inputs[0]) : "Archive"
        target = formats.first ?? "zip"
        if inputs.count == 1, formats.contains("jpg"), source == "png" { target = "jpg" }
        if inputs.count == 1, media, formats.contains("mkv") { target = "mkv" }
    }
    /// "Open in Flux" from another app, or a drop (FX-B-16): Flux keeps a private copy, then selects it as if chosen.
    func open(_ urls: [URL]) {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return }
        guard !busy else {
            notice = "Finish or cancel the current conversion, then open the file again."
            return
        }
        guard files.count <= 100 else { error = "Choose up to 100 files at a time."; return }
        var adopted: [URL] = []
        do { for url in files { adopted.append(try OpenedFiles.adopt(url)) } }
        catch { OpenedFiles.discard(adopted); self.error = error.localizedDescription; return }
        select(adopted)
    }
    func convert() {
        guard !busy, !inputs.isEmpty else { return }
        result?.remove(); result = nil; error = ""; notice = ""; message = "Converting on this device…"
        stopReason = nil; backgroundedDuringJob = false; busy = true
        let urls = inputs, target = target, filename = filename, options = options, job = JobControl()
        control = job
        let operation = urls.count > 1 ? "pack" : "convert", started = Date()
        FluxDiagnostics.jobStarted(operation: operation, source: source, target: target, files: urls.count)
        Task {
            do {
                let converted = try await Task.detached(priority: .userInitiated) {
                    try await OfflineEngine.convert(inputs: urls, target: target, name: filename, options: options, control: job)
                }.value
                if job.isCancelled { converted.remove(); try job.check() }
                result = converted; message = "Ready to save."
                FluxDiagnostics.jobFinished(operation: operation, target: target, seconds: Date().timeIntervalSince(started))
            } catch {
                FluxDiagnostics.jobFailed(operation: operation, target: target, cancelled: job.wasCancelled, error: error)
                message = ""
                // Apple's exporter fails with "interrupted" when the app leaves the foreground mid-export.
                let interrupted = (error as NSError).domain == AVFoundationErrorDomain
                    && [-11847, -11818].contains((error as NSError).code)  // AVError.operationInterrupted, .sessionWasInterrupted
                if stopReason == .background || (backgroundedDuringJob && interrupted) {
                    notice = "The conversion stopped because Flux was in the background. Convert again to restart it."
                } else if job.wasCancelled { notice = "Conversion cancelled." }
                else { self.error = error.localizedDescription }
            }
            busy = false; control = nil
        }
    }
    func cancel(_ reason: StopReason = .person) {
        guard let control else { return }
        stopReason = reason; control.cancel(); message = "Cancelling…"
    }
    /// Leaving Flux mid-conversion gives the job the time iOS allows in the background; when that runs out the job
    /// stops and says why (FX-A-01).
    func enteredBackground() {
        guard busy else { return }
        backgroundedDuringJob = true
        guard backgroundTime == .invalid else { return }
        backgroundTime = UIApplication.shared.beginBackgroundTask(withName: "Flux conversion") { [weak self] in
            MainActor.assumeIsolated { self?.cancel(.background); self?.endBackgroundTime() }
        }
        if backgroundTime == .invalid { cancel(.background) }
    }
    private func endBackgroundTime() {
        guard backgroundTime != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTime); backgroundTime = .invalid
    }
    func configurationChanged() {
        guard !busy else { return }
        if media && !options.lossless && !["mp4", "mov", "m4a", "wav", "aiff", "caf", "zip"].contains(target) {
            target = LocalFormats.audio.contains(source) ? "m4a" : "mp4"
        }
        result?.remove(); result = nil; message = ""; error = ""; notice = ""
    }
    func renameResult() async throws -> LocalResult {
        guard let result else { throw LocalError.invalid("Convert a file first.") }
        let newName = result.isDirectory ? String(try LocalPolicy.safeName(filename, extension: "folder").dropLast(7)) : try LocalPolicy.safeName(filename, extension: result.url.pathExtension)
        if newName == result.url.lastPathComponent { return result }
        let renamed = try await Task.detached { try result.renamed(to: newName) }.value
        self.result = renamed; return renamed
    }
    func clear() {
        guard !busy else { return }
        result?.remove(); result = nil; OpenedFiles.discard(inputs); inputs = []; message = ""; error = ""; notice = ""
    }
}
