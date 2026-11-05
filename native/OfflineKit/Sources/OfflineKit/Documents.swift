import Foundation
import ZIPFoundation

private final class TextXML: NSObject, XMLParserDelegate {
    var text = "", depth = 0, failure: Error?, capture = false
    let kind: String, control: JobControl
    init(kind: String, control: JobControl) { self.kind = kind; self.control = control }
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        depth += 1
        if depth > 64 || control.isCancelled { failure = LocalError.invalid("Document nesting exceeds the safety limit."); parser.abortParsing() }
        if kind == "docx", name == "w:t" { capture = true }
        if kind == "docx", name == "w:tab" { text += "\t" }
        if kind == "docx", name == "w:br" { text += "\n" }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        if kind != "docx" || capture { text += string }
        if text.utf8.count > LocalPolicy.textLimit { failure = LocalError.invalid("Document text exceeds 16 MB."); parser.abortParsing() }
    }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        if kind == "docx", name == "w:t" { capture = false }
        if ["w:p", "text:p", "text:h", "p", "div", "h1", "h2", "li", "br"].contains(name) { text += "\n" }
        depth -= 1
    }
    func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?) -> Data? { nil }
}

enum Documents {
    static func xmlText(_ data: Data, kind: String, control: JobControl) throws -> String {
        guard data.count <= LocalPolicy.textLimit, let source = String(data: data, encoding: .utf8) else { throw LocalError.invalid("Document XML is not UTF-8 or exceeds 16 MB.") }
        guard !source.localizedCaseInsensitiveContains("<!DOCTYPE"), !source.localizedCaseInsensitiveContains("<!ENTITY") else { throw LocalError.invalid("XML entities and external document types are disabled.") }
        let parser = XMLParser(data: data), delegate = TextXML(kind: kind, control: control)
        parser.shouldResolveExternalEntities = false; parser.delegate = delegate
        guard parser.parse() else { throw delegate.failure ?? parser.parserError ?? LocalError.invalid("Invalid document XML.") }
        return delegate.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func plainText(_ input: URL, control: JobControl) throws -> String {
        let ext = input.pathExtension.lowercased()
        if ["docx", "odt", "epub"].contains(ext) {
            let archive = try Archive(url: input, accessMode: .read)
            _ = try Archives.validate(archive, control: control)
            if ext == "docx" { return try xmlText(Archives.read("word/document.xml", archive: archive, control: control), kind: ext, control: control) }
            if ext == "odt" { return try xmlText(Archives.read("content.xml", archive: archive, control: control), kind: ext, control: control) }
            return try EPUB.text(archive, control: control)
        }
        let text = try LocalPolicy.readText(input)
        if ext == "html" || ext == "htm" { return try htmlText(text, control: control) }
        if ext == "rtf" { return try rtfText(text, control: control) }
        return text
    }
    static func htmlText(_ source: String, control: JobControl) throws -> String {
        guard source.utf8.count <= LocalPolicy.textLimit else { throw LocalError.invalid("HTML exceeds 16 MB.") }
        var text = try stripHiddenElements(source, control: control)
        text = text.replacingOccurrences(of: "(?i)</(?:p|div|h[1-6]|li)>|<br\\s*/?>", with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: "<[^>]{0,4096}>", with: "", options: .regularExpression)
        for (entity, value) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&apos;", "'"), ("&nbsp;", " "), ("&amp;", "&")] { text = text.replacingOccurrences(of: entity, with: value) }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// Removes script, style and head elements with the same results as the regex
    /// `(?is)<(script|style|head)\b[^>]*>.*?</\1\s*>`, in linear time. ICU's version
    /// backtracked through the rest of the file for every unclosed tag.
    /// Names and whitespace are matched as ASCII where ICU was Unicode-aware, and a
    /// non-ASCII byte after the name counts as a word character; real HTML tags are
    /// ASCII, and every difference keeps text rather than dropping it.
    static func stripHiddenElements(_ source: String, control: JobControl) throws -> String {
        let bytes = Array(source.utf8), count = bytes.count
        let names = ["script", "style", "head"].map { Array($0.utf8) }
        func lower(_ byte: UInt8) -> UInt8 { (65...90).contains(byte) ? byte + 32 : byte }
        func isWord(_ byte: UInt8) -> Bool { byte >= 0x80 || byte == 95 || (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) }
        func isSpace(_ byte: UInt8) -> Bool { byte == 32 || (9...13).contains(byte) }
        func hasName(_ name: [UInt8], at index: Int) -> Bool {
            guard index + name.count <= count else { return false }
            for offset in 0..<name.count where lower(bytes[index + offset]) != name[offset] { return false }
            return true
        }
        // Search starts only move forward, so each memo answers later queries
        // until they pass it; a failed search is never repeated.
        var greaterThan = (from: Int.max, at: count)
        var closes = Array(repeating: (from: Int.max, at: count, end: count), count: names.count)
        func nextGreaterThan(_ start: Int) -> Int? {
            if !(greaterThan.from <= start && start <= greaterThan.at) { greaterThan = (start, bytes[start...].firstIndex(of: 62) ?? count) }
            return greaterThan.at < count ? greaterThan.at : nil
        }
        /// Index of the '>' ending the first `</name\s*>` at or after `start`.
        func closeEnd(_ which: Int, _ start: Int) -> Int? {
            if !(closes[which].from <= start && start <= closes[which].at) {
                var index = start, found = (at: count, end: count)
                while found.at == count, index + 1 < count {
                    if bytes[index] == 60, bytes[index + 1] == 47, hasName(names[which], at: index + 2) {
                        var end = index + 2 + names[which].count
                        while end < count, isSpace(bytes[end]) { end += 1 }
                        if end < count, bytes[end] == 62 { found = (index, end) }
                    }
                    index += 1
                }
                closes[which] = (start, found.at, found.end)
            }
            return closes[which].at < count ? closes[which].end : nil
        }
        var output: [UInt8] = [], kept = 0, index = 0, iteration = 0
        while index < count {
            if iteration % 4096 == 0 { try control.check() }
            iteration += 1
            guard bytes[index] == 60, let which = names.indices.first(where: { hasName(names[$0], at: index + 1) }) else { index += 1; continue }
            let nameEnd = index + 1 + names[which].count
            guard nameEnd < count, !isWord(bytes[nameEnd]), let open = nextGreaterThan(nameEnd), let end = closeEnd(which, open + 1) else { index += 1; continue }
            output.append(contentsOf: bytes[kept..<index])
            index = end + 1; kept = index
        }
        if kept == 0 { return source }
        output.append(contentsOf: bytes[kept...])
        return String(decoding: output, as: UTF8.self)
    }
    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
    static func convert(_ input: URL, output: URL, target: String, control: JobControl) throws {
        if ["docx", "rtf"].contains(input.pathExtension.lowercased()), ["pdf", "html", "rtf", "docx"].contains(target) {
            try RichDocuments.convert(input, output: output, target: target, control: control); return
        }
        let text = try plainText(input, control: control)
        try control.check()
        if target == "pdf" { try ImagesPDF.textPDF(text, to: output, control: control) }
        else if target == "txt" || target == "md" { try text.write(to: output, atomically: false, encoding: .utf8) }
        else if target == "html" { try ("<!doctype html><html><head><meta charset=\"utf-8\"><title>Converted document</title></head><body><pre>" + escape(text) + "</pre></body></html>").write(to: output, atomically: false, encoding: .utf8) }
        else if target == "rtf" {
            var rtf = "{\\rtf1\\ansi\\deff0 "
            for unit in text.utf16 {
                if unit == 10 { rtf += "\\par\n" }
                else if unit == 9 { rtf += "\\tab " }
                else if [92, 123, 125].contains(unit) { rtf += "\\" + String(UnicodeScalar(unit)!) }
                else if unit < 128 { rtf += String(UnicodeScalar(unit)!) }
                else { rtf += "\\u\(Int16(bitPattern: unit))?" }
            }
            try (rtf + "}").write(to: output, atomically: false, encoding: .utf8)
        } else {
            let archive = try Archive(url: output, accessMode: .create)
            let paragraphs = text.components(separatedBy: .newlines)
            if target == "docx" {
                try Archives.add("<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>", name: "[Content_Types].xml", archive: archive)
                try Archives.add("<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>", name: "_rels/.rels", archive: archive)
                let body = paragraphs.map { "<w:p><w:r><w:t xml:space=\"preserve\">" + escape($0) + "</w:t></w:r></w:p>" }.joined()
                try Archives.add("<?xml version=\"1.0\" encoding=\"UTF-8\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>" + body + "<w:sectPr/></w:body></w:document>", name: "word/document.xml", archive: archive)
            } else if target == "odt" {
                try Archives.add("application/vnd.oasis.opendocument.text", name: "mimetype", archive: archive, compressed: false)
                let body = paragraphs.map { "<text:p>" + escape($0) + "</text:p>" }.joined()
                try Archives.add("<?xml version=\"1.0\"?><office:document-content xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\" office:version=\"1.3\"><office:body><office:text>" + body + "</office:text></office:body></office:document-content>", name: "content.xml", archive: archive)
                try Archives.add("<?xml version=\"1.0\"?><manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.3\"><manifest:file-entry manifest:full-path=\"/\" manifest:media-type=\"application/vnd.oasis.opendocument.text\"/><manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/></manifest:manifest>", name: "META-INF/manifest.xml", archive: archive)
            } else if target == "epub" {
                try Archives.add("application/epub+zip", name: "mimetype", archive: archive, compressed: false)
                try Archives.add("<?xml version=\"1.0\"?><container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>", name: "META-INF/container.xml", archive: archive)
                let body = paragraphs.map { "<p>" + escape($0) + "</p>" }.joined()
                try Archives.add("<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>Converted document</title></head><body>" + body + "</body></html>", name: "document.xhtml", archive: archive)
                try Archives.add("<?xml version=\"1.0\"?><html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\"><head><title>Contents</title></head><body><nav epub:type=\"toc\"><ol><li><a href=\"document.xhtml\">Document</a></li></ol></nav></body></html>", name: "nav.xhtml", archive: archive)
                try Archives.add("<?xml version=\"1.0\"?><package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"id\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:identifier id=\"id\">urn:uuid:\(UUID().uuidString)</dc:identifier><dc:title>Converted document</dc:title><dc:language>en</dc:language><meta property=\"dcterms:modified\">2026-10-03T00:00:00Z</meta></metadata><manifest><item id=\"text\" href=\"document.xhtml\" media-type=\"application/xhtml+xml\"/><item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/></manifest><spine><itemref idref=\"text\"/></spine></package>", name: "content.opf", archive: archive)
            } else { throw LocalError.unsupported }
        }
    }
    static func rtfText(_ source: String, control: JobControl) throws -> String {
        guard source.hasPrefix("{\\rtf") else { throw LocalError.invalid("Invalid RTF file.") }
        let chars = Array(source), count = chars.count
        var index = 0, ignored = [false], text = "", unicodeSkip = 1, fallback = 0
        var highSurrogate: UInt16?
        while index < count {
            if index % 4096 == 0 { try control.check() }
            let c = chars[index]; index += 1
            if c == "{" {
                guard ignored.count < 64 else { throw LocalError.invalid("RTF nesting exceeds its safety limit.") }
                ignored.append(ignored.last!)
            } else if c == "}" { if ignored.count > 1 { ignored.removeLast() } }
            else if c == "\\", index < count {
                let symbol = chars[index]
                if symbol == "*" { ignored[ignored.count - 1] = true; index += 1; continue }
                if ["\\", "{", "}"].contains(symbol) { if !ignored.last! { text.append(symbol) }; index += 1; continue }
                if symbol == "'", index + 2 < count {
                    if let value = UInt8(String(chars[(index + 1)...(index + 2)]), radix: 16), !ignored.last! {
                        text += String(data: Data([value]), encoding: .windowsCP1252) ?? ""
                    }
                    index += 3; continue
                }
                var word = ""
                while index < count, chars[index].isASCII, chars[index].isLetter { word.append(chars[index]); index += 1 }
                var number = ""
                if index < count, chars[index] == "-" { number.append("-"); index += 1 }
                while index < count, chars[index].isNumber { number.append(chars[index]); index += 1 }
                if index < count, chars[index] == " " { index += 1 }
                if ["fonttbl", "colortbl", "stylesheet", "info", "pict", "object"].contains(word) { ignored[ignored.count - 1] = true }
                if word == "bin" { throw LocalError.invalid("Binary RTF objects are not supported.") }
                if ignored.last! { continue }
                if word == "par" || word == "line" { text += "\n" }
                else if word == "tab" { text += "\t" }
                else if word == "uc", let n = Int(number), (0...16).contains(n) { unicodeSkip = n }
                else if word == "u", let n = Int16(number) {
                    let unit = UInt16(bitPattern: n)
                    if (0xD800...0xDBFF).contains(unit) { highSurrogate = unit }
                    else if (0xDC00...0xDFFF).contains(unit), let high = highSurrogate,
                            let scalar = UnicodeScalar(0x10000 + (UInt32(high) - 0xD800) * 1024 + UInt32(unit) - 0xDC00) {
                        text.append(Character(scalar)); highSurrogate = nil
                    } else if let scalar = UnicodeScalar(unit) { text.append(Character(scalar)); highSurrogate = nil }
                    fallback = unicodeSkip
                }
            } else if !ignored.last!, c != "\n", c != "\r" {
                if fallback > 0 { fallback -= 1 } else { text.append(c) }
            }
        }
        return text
    }
    static func subtitles(_ input: URL, output: URL, target: String) throws {
        let source = try LocalPolicy.readText(input)
        if input.pathExtension.lowercased() == target { try source.write(to: output, atomically: false, encoding: .utf8); return }
        let text = try Subtitles.convert(source, fromVTT: input.pathExtension.lowercased() == "vtt", target: target)
        try text.write(to: output, atomically: false, encoding: .utf8)
    }
}
