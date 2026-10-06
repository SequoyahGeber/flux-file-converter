import Foundation
import OfflineKit
import Darwin

/// Runs the website's conversion adapters against bundled, on-device tools.
/// Inputs are picker-authorized copies; the worker receives no arbitrary UI paths.
enum SharedMacEngine {
    static let fileLimit: Int64 = 1_900_000_000
    /// Shown above the on-device support text, whose limits and process
    /// description apply to the distributable engine, not this build.
    static var supportNote: String {
        let models = families.contains { $0["id"] as? String == "model" }
        return "Full-engine Mac build: this personal build converts with bundled command-line tools (Office, Calibre, FFmpeg, ImageMagick and others) instead of the on-device engine described below. Its limits replace those below: 5 GB per media file, 1.9 GB other files, and up to two hours per job. Each conversion runs in a separate converter process started by Flux; in Activity Monitor it appears as node and its tools under Flux. Those processes inherit Flux's App Sandbox and stop when you cancel or quit Flux. "
            + (models ? "3D models are included. " : "3D conversion is not included. ") + "Files are still converted only on this Mac."
    }
    static var resources: URL? { Bundle.main.url(forResource: "ConversionEngine", withExtension: nil) }
    static let capabilities: [String: Any] = {
        guard let root = resources, let data = try? Data(contentsOf: root.appendingPathComponent("capabilities.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return value
    }()
    static var families: [[String: Any]] { capabilities["families"] as? [[String: Any]] ?? [] }
    /// The personal full build bundles ConversionEngine. Without it, Flux uses the
    /// restricted on-device OfflineKit engine that distributable builds ship.
    static var isAvailable: Bool { resources != nil && !families.isEmpty }
    /// Matches the shared catalog's rule, so x.tar.gz is "tar.gz", not "gz".
    static func fileExtension(_ url: URL) -> String {
        let name = url.lastPathComponent.lowercased()
        for ext in ["tar.gz", "tar.bz2", "tar.xz"] where name.hasSuffix("." + ext) { return ext }
        return url.pathExtension.lowercased()
    }
    private static let running = Running()
    /// Called when the app quits; the worker also stops when its stdin closes.
    static func terminateAll() { running.terminateAll() }
    static func descriptor(_ ext: String) -> [String: Any] {
        (capabilities["formats"] as? [[String: Any]])?.first { $0["input"] as? String == ext.lowercased() } ?? [:]
    }
    static func targets(_ ext: String) -> [String] {
        let own = descriptor(ext)["targets"] as? [String] ?? []
        return own.contains("zip") ? own : own + ["zip"]
    }
    static func convert(inputs: [URL], job: [String: Any], name: String, control: JobControl) async throws -> LocalResult {
        guard let root = resources, !families.isEmpty else { throw LocalError.invalid("Flux’s bundled conversion tools are missing. Reinstall the full Mac build.") }
        let fm = FileManager.default
        let directory = OfflineEngine.jobsDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let output = directory.appendingPathComponent("output", isDirectory: true)
            try fm.createDirectory(at: output, withIntermediateDirectories: false)
            var staged: [String] = []
            var total: Int64 = 0
            for (index, source) in inputs.enumerated() {
                try control.check()
                let size = try LocalPolicy.fileSize(source)
                total += size
                let family = descriptor(fileExtension(source))["family"] as? String ?? ""
                guard size <= (["video", "audio"].contains(family) ? LocalPolicy.mediaLimit : fileLimit), total <= LocalPolicy.mediaLimit else { throw LocalError.invalid("Media is limited to 5 GB; other files to 1.9 GB.") }
                let available = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
                guard available > size + max(size, 64 * 1024 * 1024) else { throw LocalError.invalid("There is not enough free storage for the input and result.") }
                let parent = directory.appendingPathComponent("input-\(index)", isDirectory: true)
                try fm.createDirectory(at: parent, withIntermediateDirectories: false)
                let copy = parent.appendingPathComponent(source.lastPathComponent)
                try LocalPolicy.copy(source, to: copy, control: control)
                staged.append(copy.path)
            }
            var spec = job
            spec["inputs"] = staged; spec["output"] = output.path
            // Validate names here, before they become a private worker request.
            let target = job["target"] as? String ?? "zip"
            let filename = try LocalPolicy.safeName(name, extension: target)
            spec["filename"] = String(filename.dropLast(target.count + 1))
            let request = directory.appendingPathComponent("request.json"), reply = directory.appendingPathComponent("reply.json")
            spec["reply"] = reply.path
            try JSONSerialization.data(withJSONObject: spec).write(to: request)
            let log = directory.appendingPathComponent("worker.log")
            fm.createFile(atPath: log.path, contents: nil)
            let handle = try FileHandle(forWritingTo: log); defer { try? handle.close() }
            let process = Process()
            process.executableURL = root.appendingPathComponent("bin/node")
            process.arguments = ["--jitless", root.appendingPathComponent("scripts/mac-engine.cjs").path, request.path]
            process.environment = ["HOME": directory.path, "TMPDIR": directory.path, "LANG": "en_US.UTF-8", "PATH": "/usr/bin:/bin", "FLUX_PARENT_PIPE": "1"]
            process.currentDirectoryURL = directory
            process.standardOutput = handle; process.standardError = handle
            // Held open for the job; if Flux quits or crashes, the worker sees EOF
            // and stops its tools instead of running on unattended.
            let parent = Pipe()
            process.standardInput = parent
            try process.run()
            running.insert(process)
            defer { running.remove(process); try? parent.fileHandleForWriting.close() }
            var cancelledAt: TimeInterval?
            while process.isRunning {
                if control.isCancelled {
                    // SIGTERM lets the worker stop its tool process groups first.
                    if cancelledAt == nil { cancelledAt = ProcessInfo.processInfo.systemUptime; process.terminate() }
                    else if ProcessInfo.processInfo.systemUptime - cancelledAt! > 8 { kill(process.processIdentifier, SIGKILL) }
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            try control.check()
            guard process.terminationReason == .exit, process.terminationStatus == 0 else {
                throw LocalError.invalid(failureMessage(log: log, process: process))
            }
            guard let result = try JSONSerialization.jsonObject(with: Data(contentsOf: reply)) as? [String: Any],
                  let path = result["path"] as? String,
                  path.hasPrefix(output.path + "/") else { throw LocalError.invalid("The converter did not produce a valid result.") }
            let url = URL(fileURLWithPath: path), isDirectory = result["directory"] as? Bool ?? false
            let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey, .isRegularFileKey])
            guard values.isSymbolicLink != true, isDirectory ? values.isDirectory == true : values.isRegularFile == true else { throw LocalError.invalid("The converter produced an invalid result.") }
            if !isDirectory, try LocalPolicy.fileSize(url) > 6 * 1024 * 1024 * 1024 { throw LocalError.invalid("Output exceeds 6 GB.") }
            for entry in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where entry != output { try fm.removeItem(at: entry) }
            return LocalResult(url: url, directory: directory, isDirectory: isDirectory)
        } catch { try? fm.removeItem(at: directory); throw error }
    }
    /// The worker tags its user-facing error; stack traces and paths stay in the log.
    private static func failureMessage(log: URL, process: Process) -> String {
        let text = (try? String(decoding: Data(contentsOf: log).suffix(16000), as: UTF8.self)) ?? ""
        if let line = text.split(separator: "\n").last(where: { $0.hasPrefix("FLUX-ERROR: ") }) {
            let message = line.dropFirst("FLUX-ERROR: ".count).trimmingCharacters(in: .whitespaces)
            if !message.isEmpty { return message }
        }
        if process.terminationReason == .uncaughtSignal {
            return "The converter stopped unexpectedly (signal \(process.terminationStatus)). Try again, or choose another format."
        }
        return "The converter stopped without completing this file. Try again, or choose another format."
    }
}

/// Worker processes currently running, so quitting Flux can stop them.
private final class Running: @unchecked Sendable {
    private let lock = NSLock()
    private var processes: [ObjectIdentifier: Process] = [:]
    func insert(_ process: Process) { lock.lock(); processes[ObjectIdentifier(process)] = process; lock.unlock() }
    func remove(_ process: Process) { lock.lock(); processes.removeValue(forKey: ObjectIdentifier(process)); lock.unlock() }
    func terminateAll() {
        lock.lock(); let current = Array(processes.values); lock.unlock()
        for process in current where process.isRunning { process.terminate() }
    }
}
