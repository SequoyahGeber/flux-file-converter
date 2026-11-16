import Foundation

/// What quitting Flux would lose, kept apart from AppKit so `tests/mac-policy.swift` can check it (FX-B-01).
/// Converted results live only in Flux's temporary folder until they are saved, and closing the window quits the
/// app, so quitting with a running batch or unsaved results asks first. Nothing to lose: no question.
enum QuitPolicy {
    struct Prompt: Equatable {
        let title: String
        let message: String
        let quit: String
        let keep: String
    }

    static func prompt(running: Bool, unsaved: Int) -> Prompt? {
        let files = unsaved == 1 ? "1 converted file hasn’t" : "\(unsaved) converted files haven’t"
        let keep = "Keep Flux Open"
        switch (running, unsaved > 0) {
        case (false, false):
            return nil
        case (false, true):
            return Prompt(title: "Quit with unsaved results?",
                          message: "\(files) been saved. They’re deleted when Flux quits. Your original files are kept.",
                          quit: "Quit", keep: keep)
        case (true, false):
            return Prompt(title: "Quit while converting?",
                          message: "The current batch stops. Your original files are kept.",
                          quit: "Stop Batch and Quit", keep: keep)
        case (true, true):
            return Prompt(title: "Quit while converting?",
                          message: "The current batch stops, and \(files) been saved. They’re deleted when Flux quits. Your original files are kept.",
                          quit: "Stop Batch and Quit", keep: keep)
        }
    }
}
