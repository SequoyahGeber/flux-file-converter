import Foundation

enum Subtitles {
    private struct Cue { let start: Int64, end: Int64; let text: String; let identifier: String? }
    private static func timestamp(_ source: String, vtt: Bool) throws -> Int64 {
        let pattern = vtt ? "^(?:[0-9]{2,9}:)?[0-9]{2}:[0-9]{2}\\.[0-9]{3}$" : "^[0-9]{2,9}:[0-9]{2}:[0-9]{2},[0-9]{3}$"
        guard source.range(of: pattern, options: .regularExpression) != nil else { throw LocalError.invalid("Subtitle timestamp is invalid.") }
        let parts = source.replacingOccurrences(of: ",", with: ".").split(separator: ":").map(String.init)
        let seconds = parts.last!.split(separator: ".")
        let minute = Int64(parts[parts.count - 2])!, second = Int64(seconds[0])!, millis = Int64(seconds[1])!
        guard minute < 60, second < 60 else { throw LocalError.invalid("Subtitle minutes and seconds must be below 60.") }
        let hour = parts.count == 3 ? Int64(parts[0])! : 0
        return ((hour * 60 + minute) * 60 + second) * 1000 + millis
    }
    private static func format(_ time: Int64, vtt: Bool) -> String {
        String(format: "%02lld:%02lld:%02lld%@%03lld", time / 3600000, (time / 60000) % 60, (time / 1000) % 60, vtt ? "." : ",", time % 1000)
    }
    static func convert(_ source: String, fromVTT: Bool, target: String) throws -> String {
        var lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        if lines.first?.hasPrefix("\u{FEFF}") == true { lines[0].removeFirst() }
        if fromVTT {
            guard let header = lines.first, header == "WEBVTT" || header.hasPrefix("WEBVTT ") || header.hasPrefix("WEBVTT\t") else { throw LocalError.invalid("WebVTT header is missing.") }
            guard let separator = lines.firstIndex(of: "") else { throw LocalError.invalid("WebVTT header needs a blank line before cues.") }
            lines = Array(lines.dropFirst(separator + 1))
        }
        var blocks: [[String]] = [], block: [String] = []
        for line in lines {
            if line.isEmpty { if !block.isEmpty { blocks.append(block); block = [] } }
            else { block.append(line) }
        }
        if !block.isEmpty { blocks.append(block) }
        var cues: [Cue] = []
        for block in blocks {
            if fromVTT, block[0] == "NOTE" || block[0].hasPrefix("NOTE ") || block[0].hasPrefix("NOTE\t") { continue }
            if fromVTT, ["STYLE", "REGION"].contains(block[0]) { throw LocalError.invalid("Styled WebVTT regions cannot be preserved in this subtitle conversion.") }
            let index = block[0].contains("-->") ? 0 : 1
            guard index < block.count else { throw LocalError.invalid("Subtitle cue is missing its timing line.") }
            if !fromVTT, index != 1 || block[0].range(of: "^[0-9]+$", options: .regularExpression) == nil { throw LocalError.invalid("SRT cues need numeric indices.") }
            let timing = block[index].components(separatedBy: "-->")
            guard timing.count == 2 else { throw LocalError.invalid("Subtitle cue timing is invalid.") }
            let endParts = timing[1].split(whereSeparator: { $0.isWhitespace })
            guard let endToken = endParts.first, fromVTT || endParts.count == 1 else { throw LocalError.invalid("Subtitle timing settings are invalid.") }
            // SRT/TXT preserve cue text and timing, but not VTT positioning.
            let start = try timestamp(timing[0].trimmingCharacters(in: .whitespaces), vtt: fromVTT)
            let end = try timestamp(String(endToken), vtt: fromVTT)
            guard end > start, block.count > index + 1 else { throw LocalError.invalid("Subtitle cue needs text and an end after its start.") }
            let text = block.dropFirst(index + 1).joined(separator: "\n")
            cues.append(Cue(start: start, end: end, text: text, identifier: fromVTT && index == 1 ? block[0] : nil))
        }
        guard !cues.isEmpty else { throw LocalError.invalid("No subtitle cues were found.") }
        if target == "txt" { return cues.map(\.text).joined(separator: "\n\n") + "\n" }
        let toVTT = target == "vtt"
        let output = (toVTT ? "WEBVTT\n\n" : "") + cues.enumerated().map { index, cue in
            let label = toVTT ? cue.identifier.map { $0 + "\n" } ?? "" : "\(index + 1)\n"
            return label + format(cue.start, vtt: toVTT) + " --> " + format(cue.end, vtt: toVTT) + "\n" + cue.text + "\n\n"
        }.joined()
        guard output.utf8.count <= LocalPolicy.textLimit else { throw LocalError.invalid("Converted subtitles exceed 16 MB.") }
        return output
    }
}
