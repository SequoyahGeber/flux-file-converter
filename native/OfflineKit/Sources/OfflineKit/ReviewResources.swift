import Foundation

/// Synthetic examples use the same converter and save flow as user-selected files.
public enum ReviewResources {
    public struct Sample: Sendable {
        public let id: String
        public let title: String
        public let filename: String
        public let target: String
        public var url: URL? { Bundle.module.url(forResource: filename, withExtension: nil) }
    }
    public static let samples: [Sample] = [
        Sample(id: "image", title: "Sample image · PNG → JPG", filename: "Flux-sample-image.png", target: "jpg"),
        Sample(id: "document", title: "Sample document · DOCX → PDF", filename: "Flux-sample-document.docx", target: "pdf"),
        Sample(id: "video", title: "Sample video · MP4 → MKV", filename: "Flux-sample-video.mp4", target: "mkv"),
        Sample(id: "data", title: "Sample data · JSON → CSV", filename: "Flux-sample-data.json", target: "csv"),
        Sample(id: "archive", title: "Sample archive · ZIP → folder", filename: "Flux-sample-archive.zip", target: "unzip")
    ]
    public static let privacyURL = URL(string: "https://sequoyahgeber.github.io/flux-file-converter/privacy/")!
    public static let supportURL = URL(string: "https://sequoyahgeber.github.io/flux-file-converter/support/")!
    public static var privacyText: String { text("Flux-privacy.txt") }
    public static var supportText: String { text("Flux-support.txt") }
    private static func text(_ name: String) -> String {
        guard let url = Bundle.module.url(forResource: name, withExtension: nil),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "The bundled information is unavailable. Please use the public policy or support page." }
        return text
    }
}
