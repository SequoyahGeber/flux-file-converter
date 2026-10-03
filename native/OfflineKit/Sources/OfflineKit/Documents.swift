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
            let entries = try Archives.validate(archive, control: control)
            if ext == "docx" { return try xmlText(Archives.read("word/document.xml", archive: archive, control: control), kind: ext, control: control) }
            if ext == "odt" { return try xmlText(Archives.read("content.xml", archive: archive, control: control), kind: ext, control: control) }
            var text = ""
            for entry in entries.filter({ ["xhtml", "html", "htm"].contains(URL(fileURLWithPath: $0.path).pathExtension.lowercased()) }).sorted(by: { $0.path < $1.path }) {
                let data = try Archives.read(entry.path, archive: archive, control: control)
                guard let html = String(data: data, encoding: .utf8) else { throw LocalError.invalid("EPUB chapter is not UTF-8.") }
                text += try htmlText(html) + "\n\n"
                if text.utf8.count > LocalPolicy.textLimit { throw LocalError.invalid("EPUB text exceeds 16 MB.") }
            }
            return text
        }
        let text = try LocalPolicy.readText(input)
        if ext == "html" || ext == "htm" { return try htmlText(text) }
        if ext == "rtf" { return try rtfText(text, control: control) }
        return text
    }
    static func htmlText(_ source: String) throws -> String {
        guard source.utf8.count <= LocalPolicy.textLimit else { throw LocalError.invalid("HTML exceeds 16 MB.") }
        var text = source.replacingOccurrences(of: "(?is)<(script|style|head)\\b[^>]*>.*?</\\1\\s*>", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "(?i)</(?:p|div|h[1-6]|li)>|<br\\s*/?>", with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: "<[^>]{0,4096}>", with: "", options: .regularExpression)
        for (entity, value) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&apos;", "'"), ("&nbsp;", " "), ("&amp;", "&")] { text = text.replacingOccurrences(of: entity, with: value) }
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
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
        var text = try LocalPolicy.readText(input)
        if input.pathExtension.lowercased() == "vtt" {
            text = text.replacingOccurrences(of: "(?m)^WEBVTT[^\n]*\n", with: "", options: .regularExpression)
            text = text.replacingOccurrences(of: "(\\d{2}:\\d{2}:\\d{2})\\.(\\d{3})", with: "$1,$2", options: .regularExpression)
        }
        if target == "vtt" {
            text = "WEBVTT\n\n" + text.replacingOccurrences(of: "(\\d{2}:\\d{2}:\\d{2}),(\\d{3})", with: "$1.$2", options: .regularExpression)
        } else if target == "txt" {
            text = text.replacingOccurrences(of: "(?m)^.*-->.*\n|^\\d+\\s*$", with: "", options: .regularExpression)
        }
        try text.write(to: output, atomically: false, encoding: .utf8)
    }
}
