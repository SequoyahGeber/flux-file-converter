import Foundation

/// Save All's wording (FX-B-11), kept apart from AppKit so `tests/mac-policy.swift` can check it.
enum SaveAllPolicy {
    static func files(_ count: Int) -> String { count == 1 ? "1 file" : "\(count) files" }
    /// The folder panel's message when no Settings folder is chosen.
    static func panelMessage(count: Int) -> String { "Choose a folder for \(files(count)). Files already there are kept; new names get a number." }
    /// One line for the page: how many were saved where, and which could not be.
    static func summary(saved: Int, failed: [String], folder: String) -> String {
        let done = saved > 0 ? "Saved \(files(saved)) to “\(folder)”." : ""
        guard !failed.isEmpty else { return done }
        let names = failed.prefix(3).map { "“\($0)”" }.joined(separator: ", ") + (failed.count > 3 ? " and \(failed.count - 3) more" : "")
        let failure = "Couldn’t save \(names). Try Save as… for \(failed.count == 1 ? "it" : "them")."
        return done.isEmpty ? failure : done + " " + failure
    }
}
