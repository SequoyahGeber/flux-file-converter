import Foundation
import CoreText
import ImageIO
import ZIPFoundation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

private final class XMLNode {
    let name: String, attributes: [String: String]
    var children: [XMLNode] = [], text = ""
    init(_ name: String, _ attributes: [String: String]) { self.name = name; self.attributes = attributes }
    func first(_ name: String) -> XMLNode? { children.first { $0.name == name } }
    func all(_ name: String) -> [XMLNode] { children.filter { $0.name == name } }
    func descendants(_ name: String) -> [XMLNode] { children.flatMap { ($0.name == name ? [$0] : []) + $0.descendants(name) } }
    var value: String? { attributes["w:val"] }
}
private final class XMLTree: NSObject, XMLParserDelegate {
    var root: XMLNode?, stack: [XMLNode] = [], count = 0, bytes = 0, failure: Error?
    let control: JobControl
    init(_ control: JobControl) { self.control = control }
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        count += 1
        guard stack.count < 64, count < 100_000, !control.isCancelled else { failure = LocalError.invalid("Document nesting or node limit exceeded."); parser.abortParsing(); return }
        let node = XMLNode(name, attributes)
        if let parent = stack.last { parent.children.append(node) } else { root = node }
        stack.append(node)
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        bytes += string.utf8.count
        guard bytes <= LocalPolicy.textLimit else { failure = LocalError.invalid("Document text exceeds 16 MB."); parser.abortParsing(); return }
        stack.last?.text += string
    }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) { if !stack.isEmpty { stack.removeLast() } }
    static func parse(_ data: Data, control: JobControl) throws -> XMLNode {
        guard let text = String(data: data, encoding: .utf8), !text.localizedCaseInsensitiveContains("<!DOCTYPE"), !text.localizedCaseInsensitiveContains("<!ENTITY") else { throw LocalError.invalid("XML entities and external document types are disabled.") }
        let parser = XMLParser(data: data), delegate = XMLTree(control)
        parser.shouldResolveExternalEntities = false; parser.delegate = delegate
        guard parser.parse(), let root = delegate.root else { throw delegate.failure ?? parser.parserError ?? LocalError.invalid("Invalid document XML.") }
        return root
    }
}

private struct RunStyle {
    var fontName = "Helvetica", size: CGFloat = 11, bold = false, italic = false, underline = false
    var color = CGColor(gray: 0, alpha: 1)
    mutating func apply(_ properties: XMLNode?) {
        guard let p = properties else { return }
        if let n = p.first("w:rFonts")?.attributes["w:ascii"] { fontName = String(n.prefix(128)) }
        if let value = p.first("w:sz")?.value.flatMap(Double.init), value.isFinite { size = min(144, max(6, value / 2)) }
        if let node = p.first("w:b") { bold = node.value != "0" && node.value != "false" }
        if let node = p.first("w:i") { italic = node.value != "0" && node.value != "false" }
        if let node = p.first("w:u") { underline = node.value != "none" }
        if let value = p.first("w:color")?.value, value.count == 6, let hex = UInt32(value, radix: 16) {
            color = CGColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
        }
    }
    var attributes: [NSAttributedString.Key: Any] {
        let regular = CTFontCreateWithName(fontName as CFString, size, nil)
        var traits: CTFontSymbolicTraits = []
        if bold { traits.insert(.traitBold) }; if italic { traits.insert(.traitItalic) }
        let font = CTFontCreateCopyWithSymbolicTraits(regular, size, nil, traits, traits) ?? regular
        var values: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]
        if underline { values[NSAttributedString.Key(kCTUnderlineStyleAttributeName as String)] = CTUnderlineStyle.single.rawValue }
        return values
    }
}

private enum RichBlock {
    case paragraph(NSAttributedString)
    case image(CGImage, CGFloat, CGFloat)
    case table([[NSAttributedString]])
    case pageBreak
}

enum RichDocuments {
    static func convert(_ input: URL, output: URL, target: String, control: JobControl) throws {
        if target == input.pathExtension.lowercased() { try LocalPolicy.copy(input, to: output, control: control); return }
        if input.pathExtension.lowercased() == "rtf" {
            let source = try LocalPolicy.readText(input)
            _ = try Documents.rtfText(source, control: control) // validates nesting/binary destinations
            guard !source.contains("\\object"), !source.contains("\\pict") else { throw LocalError.invalid("RTF with embedded objects/images is not supported by this local renderer.") }
            let attributed = try NSAttributedString(data: Data(source.utf8), options: [.documentType: NSAttributedString.DocumentType.rtf], documentAttributes: nil)
            if target == "pdf" { try render([.paragraph(attributed)], page: CGSize(width: 612, height: 792), margins: [36, 36, 36, 36], output: output, control: control) }
            else if target == "html" { try attributed.data(from: NSRange(location: 0, length: attributed.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.html]).write(to: output) }
            else { throw LocalError.unsupported }
            return
        }
        let archive = try Archive(url: input, accessMode: .read)
        _ = try Archives.validate(archive, control: control)
        let document = try XMLTree.parse(Archives.read("word/document.xml", archive: archive, control: control), control: control)
        guard let body = document.first("w:body") else { throw LocalError.invalid("DOCX has no document body.") }
        let unsupported = ["w:headerReference", "w:footerReference", "w:footnoteReference", "w:endnoteReference", "wp:anchor", "w:altChunk", "w:vMerge", "w:gridSpan", "w:object", "w:pict", "w:fldSimple"]
        for name in unsupported where !document.descendants(name).isEmpty {
            throw LocalError.invalid("This DOCX contains \(name.split(separator: ":").last!) that the local layout engine does not support. The document was not flattened; you can explicitly extract TXT instead.")
        }
        guard document.descendants("w:sectPr").count <= 1 else { throw LocalError.invalid("DOCX with multiple page sections is not supported by the local renderer.") }
        if let columns = document.descendants("w:cols").first?.attributes["w:num"].flatMap(Int.init), columns > 1 { throw LocalError.invalid("DOCX with multiple columns is not supported by the local renderer.") }
        var styles: [String: XMLNode] = [:]
        var base = RunStyle()
        if archive["word/styles.xml"] != nil {
            let tree = try XMLTree.parse(Archives.read("word/styles.xml", archive: archive, control: control), control: control)
            for style in tree.all("w:style") { if let id = style.attributes["w:styleId"] { styles[id] = style } }
            base.apply(tree.first("w:docDefaults")?.first("w:rPrDefault")?.first("w:rPr"))
        }
        func inherited(_ id: String?, depth: Int = 0) -> RunStyle {
            guard depth < 12, let id, let style = styles[id] else { return base }
            var value = inherited(style.first("w:basedOn")?.value, depth: depth + 1)
            value.apply(style.first("w:rPr")); return value
        }
        var relationships: [String: String] = [:]
        if archive["word/_rels/document.xml.rels"] != nil {
            let tree = try XMLTree.parse(Archives.read("word/_rels/document.xml.rels", archive: archive, control: control), control: control)
            for rel in tree.children where rel.attributes["TargetMode"] != "External" {
                if let id = rel.attributes["Id"], let target = rel.attributes["Target"] { relationships[id] = target }
            }
        }
        var numbering: [String: String] = [:], counts: [String: Int] = [:]
        if archive["word/numbering.xml"] != nil {
            let tree = try XMLTree.parse(Archives.read("word/numbering.xml", archive: archive, control: control), control: control)
            var definitions: [String: XMLNode] = [:]
            for node in tree.all("w:abstractNum") {
                guard let id = node.attributes["w:abstractNumId"] else { continue }
                guard definitions[id] == nil else { throw LocalError.invalid("DOCX numbering contains duplicate identifiers.") }
                definitions[id] = node
            }
            for number in tree.all("w:num") {
                guard let id = number.attributes["w:numId"], let abstract = number.first("w:abstractNumId")?.value, let definition = definitions[abstract] else { continue }
                for level in definition.all("w:lvl") {
                    if let depth = level.attributes["w:ilvl"], let format = level.first("w:numFmt")?.value { numbering[id + ":" + depth] = format }
                }
            }
        }
        func paragraph(_ node: XMLNode) throws -> NSAttributedString {
            let properties = node.first("w:pPr")
            let style = inherited(properties?.first("w:pStyle")?.value)
            let text = NSMutableAttributedString(string: "")
            let format = NSMutableParagraphStyle(); format.paragraphSpacing = 8
            if let align = properties?.first("w:jc")?.value {
                format.alignment = ["center": .center, "right": .right, "both": .justified][align] ?? .left
            }
            if let indent = properties?.first("w:ind")?.attributes["w:left"].flatMap(Double.init), indent.isFinite { format.headIndent = min(200, max(0, indent / 20)); format.firstLineHeadIndent = format.headIndent }
            if let num = properties?.first("w:numPr"), let id = num.first("w:numId")?.value {
                let key = id + ":" + (num.first("w:ilvl")?.value ?? "0")
                let kind = numbering[key] ?? "bullet"
                guard kind == "decimal" || kind == "bullet" else { throw LocalError.invalid("This list numbering style is not supported by the local renderer.") }
                counts[key, default: 0] += 1
                text.append(NSAttributedString(string: kind == "bullet" ? "• " : "\(counts[key]!). ", attributes: style.attributes))
            }
            for run in node.descendants("w:r") {
                var runStyle = style
                if let id = run.first("w:rPr")?.first("w:rStyle")?.value { runStyle = inherited(id) }
                runStyle.apply(run.first("w:rPr"))
                for child in run.children {
                    if child.name == "w:t" { text.append(NSAttributedString(string: child.text, attributes: runStyle.attributes)) }
                    else if child.name == "w:tab" { text.append(NSAttributedString(string: "\t", attributes: runStyle.attributes)) }
                    else if child.name == "w:br" && child.attributes["w:type"] != "page" { text.append(NSAttributedString(string: "\n", attributes: runStyle.attributes)) }
                }
            }
            if text.length == 0 { text.append(NSAttributedString(string: " ", attributes: style.attributes)) }
            text.addAttribute(.paragraphStyle, value: format, range: NSRange(location: 0, length: text.length)); return text
        }
        var page = CGSize(width: 612, height: 792), margins: [CGFloat] = [36, 36, 36, 36]
        if let section = body.first("w:sectPr") {
            if let size = section.first("w:pgSz"), let w = size.attributes["w:w"].flatMap(Double.init), let h = size.attributes["w:h"].flatMap(Double.init), w.isFinite, h.isFinite, (1440...28800).contains(w), (1440...28800).contains(h) { page = CGSize(width: w / 20, height: h / 20) }
            if let m = section.first("w:pgMar") {
                margins = ["w:top", "w:right", "w:bottom", "w:left"].map { key in
                    guard let value = m.attributes[key].flatMap(Double.init), value.isFinite else { return 36 }
                    return min(min(page.width, page.height) / 3, max(0, value / 20))
                }
            }
        }
        var blocks: [RichBlock] = [], imageBytes = 0
        for node in body.children {
            try control.check()
            if node.name == "w:p" {
                if node.first("w:pPr")?.first("w:pageBreakBefore") != nil { blocks.append(.pageBreak) }
                blocks.append(.paragraph(try paragraph(node)))
                for drawing in node.descendants("w:drawing") {
                    guard let blip = drawing.descendants("a:blip").first, blip.attributes["r:link"] == nil,
                          let id = blip.attributes["r:embed"], let relationship = relationships[id] else { throw LocalError.invalid("DOCX image is missing or references an external resource.") }
                    let relative = try Archives.path(relationship)
                    let data = try Archives.read("word/" + relative, archive: archive, control: control)
                    imageBytes += data.count
                    guard imageBytes <= 64 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil),
                          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                          let w = properties[kCGImagePropertyPixelWidth] as? Int, let h = properties[kCGImagePropertyPixelHeight] as? Int,
                          w > 0, h > 0, Int64(w) * Int64(h) <= 24_000_000,
                          let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { throw LocalError.invalid("DOCX image exceeds its safety limit or uses an unsupported codec.") }
                    let extent = drawing.descendants("wp:extent").first
                    let width = extent?.attributes["cx"].flatMap(Double.init).map { $0 / 12700 } ?? Double(w)
                    let height = extent?.attributes["cy"].flatMap(Double.init).map { $0 / 12700 } ?? Double(h)
                    guard width.isFinite, height.isFinite, width > 0, height > 0, width <= 14400, height <= 14400 else { throw LocalError.invalid("Invalid document image dimensions.") }
                    blocks.append(.image(image, width, height))
                }
                if !node.descendants("w:br").filter({ $0.attributes["w:type"] == "page" }).isEmpty { blocks.append(.pageBreak) }
            } else if node.name == "w:tbl" {
                let rows = try node.all("w:tr").map { row in
                    try row.all("w:tc").map { cell -> NSAttributedString in
                        guard cell.descendants("w:tbl").isEmpty else { throw LocalError.invalid("Nested DOCX tables are not supported.") }
                        guard cell.descendants("w:drawing").isEmpty else { throw LocalError.invalid("DOCX images inside table cells are not supported by the local renderer.") }
                        let text = NSMutableAttributedString(string: "")
                        for p in cell.all("w:p") { text.append(try paragraph(p)); text.append(NSAttributedString(string: "\n")) }
                        return text
                    }
                }
                guard rows.count <= 2000, rows.allSatisfy({ !$0.isEmpty && $0.count <= 16 }) else { throw LocalError.invalid("Table exceeds its row or column limit.") }
                blocks.append(.table(rows))
            } else if node.name != "w:sectPr" { throw LocalError.invalid("DOCX body contains an unsupported layout structure.") }
        }
        if target == "pdf" { try render(blocks, page: page, margins: margins, output: output, control: control) }
        else if target == "rtf" {
            let text = NSMutableAttributedString(string: "")
            for block in blocks {
                switch block {
                case .paragraph(let value): text.append(value); text.append(NSAttributedString(string: "\n"))
                case .pageBreak: text.append(NSAttributedString(string: "\u{000C}"))
                case .image, .table: throw LocalError.invalid("RTF export of this DOCX cannot preserve its images/tables. Choose PDF or HTML.")
                }
            }
            try text.data(from: NSRange(location: 0, length: text.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf]).write(to: output)
        } else if target == "html" { try writeHTML(blocks, output: output, control: control) }
        else { throw LocalError.unsupported }
    }
    private static func render(_ blocks: [RichBlock], page: CGSize, margins: [CGFloat], output: URL, control: JobControl) throws {
        guard let context = CGContext(output as CFURL, mediaBox: nil, nil) else { throw LocalError.unsupported }
        let width = page.width - margins[1] - margins[3], available = page.height - margins[0] - margins[2]
        guard width >= 72, available >= 72 else { throw LocalError.invalid("Document page margins leave too little room for content.") }
        var top = page.height - margins[0], pages = 0
        func newPage() throws {
            if pages > 0 { context.endPDFPage() }
            try control.check(); pages += 1
            guard pages <= 500 else { throw LocalError.invalid("Document exceeds 500 rendered pages.") }
            var bounds = CGRect(origin: .zero, size: page)
            context.beginPDFPage([kCGPDFContextMediaBox as String: Data(bytes: &bounds, count: MemoryLayout<CGRect>.size)] as CFDictionary)
            context.textMatrix = .identity; top = page.height - margins[0]
        }
        try newPage()
        for block in blocks {
            try control.check()
            switch block {
            case .pageBreak: try newPage()
            case .paragraph(let text):
                let setter = CTFramesetterCreateWithAttributedString(text); var start = 0
                while start < text.length {
                    if top - margins[2] < 20 { try newPage() }
                    let needed = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: start, length: 0), nil, CGSize(width: width, height: .greatestFiniteMagnitude), nil).height + 2
                    let height = min(top - margins[2], needed)
                    let path = CGPath(rect: CGRect(x: margins[3], y: top - height, width: width, height: height), transform: nil)
                    let frame = CTFramesetterCreateFrame(setter, CFRange(location: start, length: 0), path, nil)
                    let range = CTFrameGetVisibleStringRange(frame)
                    guard range.length > 0 else { throw LocalError.invalid("Document text cannot fit within its page margins.") }
                    CTFrameDraw(frame, context); start += range.length; top -= height + 8
                    if start < text.length { try newPage() }
                }
            case .image(let image, let w, let h):
                let scale = min(1, min(width / w, available / h)), height = h * scale
                if top - height < margins[2] { try newPage() }
                context.draw(image, in: CGRect(x: margins[3], y: top - height, width: w * scale, height: height)); top -= height + 8
            case .table(let rows):
                for row in rows {
                    let cellWidth = width / CGFloat(row.count)
                    guard cellWidth >= 24 else { throw LocalError.invalid("Table columns cannot fit within the document page.") }
                    let height = row.map { CTFramesetterSuggestFrameSizeWithConstraints(CTFramesetterCreateWithAttributedString($0), CFRange(location: 0, length: 0), nil, CGSize(width: cellWidth - 12, height: .greatestFiniteMagnitude), nil).height + 16 }.max() ?? 20
                    guard height <= available else { throw LocalError.invalid("A table row is taller than a page. This layout cannot be preserved.") }
                    if top - height < margins[2] { try newPage() }
                    for (index, text) in row.enumerated() {
                        let rect = CGRect(x: margins[3] + CGFloat(index) * cellWidth, y: top - height, width: cellWidth, height: height)
                        context.setStrokeColor(CGColor(gray: 0.65, alpha: 1)); context.setLineWidth(0.5); context.stroke(rect)
                        let frame = CTFramesetterCreateFrame(CTFramesetterCreateWithAttributedString(text), CFRange(location: 0, length: 0), CGPath(rect: rect.insetBy(dx: 6, dy: 6), transform: nil), nil)
                        CTFrameDraw(frame, context)
                    }
                    top -= height
                }
                top -= 8
            }
        }
        context.endPDFPage(); context.closePDF()
    }
    private static func writeHTML(_ blocks: [RichBlock], output: URL, control: JobControl) throws {
        func html(_ text: NSAttributedString) throws -> String {
            var value = "<p style=\"white-space:pre-wrap;\">"
            text.enumerateAttributes(in: NSRange(location: 0, length: text.length)) { attributes, range, _ in
                var css = ""
                if let raw = attributes[NSAttributedString.Key(kCTFontAttributeName as String)] {
                    let font = raw as! CTFont
                    css += "font-family:'" + (CTFontCopyFamilyName(font) as String).replacingOccurrences(of: "'", with: "") + "';font-size:\(CTFontGetSize(font))pt;"
                    let traits = CTFontGetSymbolicTraits(font)
                    if traits.contains(.traitBold) { css += "font-weight:bold;" }
                    if traits.contains(.traitItalic) { css += "font-style:italic;" }
                }
                if let raw = attributes[NSAttributedString.Key(kCTForegroundColorAttributeName as String)], CFGetTypeID(raw as CFTypeRef) == CGColor.typeID {
                    let color = raw as! CGColor
                    if let rgb = color.converted(to: CGColorSpaceCreateDeviceRGB(), intent: .defaultIntent, options: nil)?.components, rgb.count >= 3 {
                        css += "color:rgb(\(Int(rgb[0] * 255)),\(Int(rgb[1] * 255)),\(Int(rgb[2] * 255)));"
                    }
                }
                if attributes[.underlineStyle] != nil { css += "text-decoration:underline;" }
                value += "<span style=\"" + Documents.escape(css) + "\">" + Documents.escape(text.attributedSubstring(from: range).string) + "</span>"
            }
            return value + "</p>"
        }
        var result = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Converted document</title></head><body>"
        for block in blocks {
            try control.check()
            switch block {
            case .paragraph(let text): result += try html(text)
            case .pageBreak: result += "<hr style=\"break-after:page\">"
            case .table(let rows):
                result += "<table border=\"1\">"
                for row in rows { result += "<tr>"; for cell in row { result += "<td>" + (try html(cell)) + "</td>" }; result += "</tr>" }; result += "</table>"
            case .image(let image, let width, let height):
                let data = NSMutableData()
                guard let encoder = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { throw LocalError.unsupported }
                CGImageDestinationAddImage(encoder, image, nil)
                guard CGImageDestinationFinalize(encoder) else { throw LocalError.unsupported }
                result += "<img alt=\"Embedded document image\" width=\"\(Int(width))\" height=\"\(Int(height))\" src=\"data:image/png;base64,\((data as Data).base64EncodedString())\">"
            }
            guard result.utf8.count <= 128 * 1024 * 1024 else { throw LocalError.invalid("HTML output exceeds 128 MB.") }
        }
        try (result + "</body></html>").write(to: output, atomically: false, encoding: .utf8)
    }
}
