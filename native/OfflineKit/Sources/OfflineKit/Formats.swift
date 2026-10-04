import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum LocalFormats {
    public static let images = ["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "bmp", "ico", "webp", "avif"]
    public static let video = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "ts", "mts", "m2ts", "mpg", "mpeg", "flv", "wmv"]
    public static let audio = ["m4a", "aac", "mp3", "flac", "ogg", "opus", "wav", "aif", "aiff", "caf", "ac3", "wma"]
    public static let documents = ["txt", "md", "html", "htm", "docx", "odt", "epub", "rtf"]
    public static let data = ["json", "csv", "tsv", "yaml", "yml"]
    public static var imageOutputs: [String] {
        let types = CGImageDestinationCopyTypeIdentifiers() as! [String]
        return ["png", "jpg", "heic", "tiff", "gif", "bmp", "ico", "webp", "avif"].filter {
            guard let type = UTType(filenameExtension: $0) else { return false }
            return types.contains(type.identifier)
        }
    }
    public static func outputs(for ext: String) -> [String] {
        let ext = ext.lowercased()
        var outputs: [String] = []
        if images.contains(ext) { outputs = imageOutputs + ["pdf"] }
        else if ext == "pdf" { outputs = imageOutputs + ["txt", "pdf"] }
        else if video.contains(ext) { outputs = ["mp4", "mov", "mkv", "webm", "avi", "ts", "m4a", "wav", "aiff", "caf"] }
        else if audio.contains(ext) { outputs = ["m4a", "wav", "aiff", "caf", "mkv", "ogg", "flac", "mp3", "aac"] }
        else if data.contains(ext) { outputs = ["json", "csv", "tsv", "yaml"] }
        else if ext == "docx" { outputs = ["pdf", "html", "rtf", "docx", "txt", "md"] }
        else if ext == "rtf" { outputs = ["pdf", "html", "rtf", "txt", "md"] }
        else if ["odt", "epub", "html", "htm"].contains(ext) { outputs = ["txt", "md"] }
        else if documents.contains(ext) { outputs = ["pdf", "txt", "md", "html", "docx", "odt", "epub", "rtf"] }
        else if ["srt", "vtt"].contains(ext) { outputs = ["srt", "vtt", "txt"] }
        if ext == "zip" { outputs = ["unzip"] }
        return outputs + ["zip"]
    }
    public static func note(source: String, target: String, lossless: Bool) -> String {
        if target == "zip" { return "Lossless archive. ZIP can package any selected file type." }
        if target == "unzip" { return "Extracts safely into a folder. Entries are never opened or executed." }
        if images.contains(source), target == "pdf" { return "Creates a PDF from the first image frame." }
        if source == "pdf", imageOutputs.contains(target) { return "Renders the first PDF page at up to 2× resolution." }
        if source == "pdf", target == "pdf" { return "Lossy compression: renders pages at reduced resolution and removes editable text, forms and links." }
        if ["docx", "rtf"].contains(source), ["pdf", "html", "rtf", "docx"].contains(target) {
            if source == target { return "Keeps the complete original document without changing its contents." }
            return "Preserves supported fonts and text styling. DOCX PDF/HTML also retains basic tables and embedded images. Layout may differ; unsupported structures report an error."
        }
        if documents.contains(source), source != "txt", source != "md" { return "Extract text only: this output removes layout, images, tables and styling. Choose PDF/HTML for supported rich DOCX/RTF conversions." }
        if video.contains(source) || audio.contains(source) {
            if lossless { return "Copies encoded tracks without quality loss. The destination must support every track’s codec; incompatible conversions will report an error." }
            return "Uses Apple’s local media codecs. Re-encoding can reduce quality. Unsupported input codecs will report an error."
        }
        if target == "jpg" { return "Lossy JPEG compression. Transparency is filled with white; only the first frame is converted." }
        if images.contains(source) { return "Converts the first image frame. Palette formats and color-space changes can alter colors." }
        if data.contains(source) { return "CSV/TSV require an array of records. Complex nested values use JSON strings in cells. Formula-like text is prefixed with an apostrophe for spreadsheet safety." }
        return "Conversion stays on this device."
    }
}
