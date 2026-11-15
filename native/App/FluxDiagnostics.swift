// SHARED-EXPERIENCE: diagnostics | standard: PROJECT_STANDARDS.md §Diagnostics | package: SharedKit/Diagnostics 0.x
import Foundation
import SharedDiagnostics

/// Flux's one diagnostics center: the journal feedback attaches, MetricKit, and the unexpected-quit marker.
/// The journal lives in Application Support (SharedKit's default), never in the temporary folder that
/// `OfflineEngine.clearTemporaryFiles()` empties at every launch.
@MainActor
enum FluxDiagnostics {
    /// Every built-in rule: names in typographic quotes (Foundation errors), paths, addresses, long tokens.
    static let redactor = Redactor(rules: .all)
    static let center = DiagnosticsCenter(configuration: DiagnosticsConfiguration(appName: "Flux", redactor: redactor))
    /// Flux's own category for conversion, compression and archive jobs.
    static let conversion: LogCategory = "conversion"

    /// The names of files chosen and results made in this session, kept out of every log and report.
    /// Set by the screen that owns them (the iPhone model, the Mac bridge).
    static var fileNames: @MainActor () -> [String] = { [] }

    static func start() {
        center.start()
    }

    /// A job started. Only formats and counts are recorded, never a name.
    static func jobStarted(operation: String, source: String, target: String, files: Int) {
        center.journal.record(.info, conversion, "start", [
            "operation": .token(operation), "from": .token(source), "to": .token(target), "files": .int(files),
        ])
    }

    static func jobFinished(operation: String, target: String, seconds: TimeInterval) {
        center.journal.record(.info, conversion, "done", [
            "operation": .token(operation), "to": .token(target), "duration": .seconds(seconds),
        ])
    }

    static func jobFailed(operation: String, target: String, cancelled: Bool, error: any Error) {
        center.journal.record(cancelled ? .info : .error, conversion, cancelled ? "cancelled" : "failed", [
            "operation": .token(operation), "to": .token(target), "error": .error(error),
        ])
    }
}
