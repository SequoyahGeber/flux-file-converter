import Foundation
import PDFKit
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(message.utf8)); exit(1)
}
let args = CommandLine.arguments
if args.count < 3 { fail("Usage: pdf-tool inspect|text|render input [output] [png|jpg] [dpi]") }
guard let doc = PDFDocument(url: URL(fileURLWithPath: args[2])) else { fail("This PDF could not be opened. It may be damaged.") }
if doc.isLocked { fail("This PDF is password-protected. Unlock it before converting.") }
if doc.pageCount < 1 || doc.pageCount > 1000 { fail("Choose a PDF with between 1 and 1,000 pages.") }
switch args[1] {
case "inspect":
    print("{\"pages\":\(doc.pageCount)}")
case "text":
    var text = "", bytes = 0
    for i in 0..<doc.pageCount {
        let page = autoreleasepool { doc.page(at: i)?.string ?? "" }
        bytes += page.utf8.count + 2
        if bytes > 50 * 1024 * 1024 { fail("Extracted PDF text exceeds 50 MB.") }
        text += page + "\n\n"
    }
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { fail("This PDF has no selectable text. It needs OCR before text conversion.") }
    if args.count < 4 { fail("Missing output path") }
    do { try text.write(toFile: args[3], atomically: true, encoding: .utf8) } catch { fail(error.localizedDescription) }
case "render":
    if args.count < 6 { fail("Missing output folder, format, or resolution") }
    let scale = (Double(args[5]) ?? 144) / 72
    if !scale.isFinite || scale <= 0 || scale > 4 { fail("Invalid PDF rendering resolution.") }
    let format = args[4]
    for i in 0..<doc.pageCount {
        autoreleasepool {
        guard let page = doc.page(at: i) else { fail("A PDF page could not be read.") }
        let bounds = page.bounds(for: .mediaBox)
        if !bounds.width.isFinite || !bounds.height.isFinite || !bounds.minX.isFinite || !bounds.minY.isFinite || bounds.width <= 0 || bounds.height <= 0 || bounds.width * scale > 16000 || bounds.height * scale > 16000 { fail("Invalid or oversized PDF page dimensions.") }
        let width = max(1, Int(ceil(bounds.width * scale)))
        let height = max(1, Int(ceil(bounds.height * scale)))
        if width > 16000 || height > 16000 || width * height > 100_000_000 { fail("A PDF page is too large to render at this resolution.") }
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fail("Could not create page image") }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let cg = context.cgContext
        cg.setFillColor(NSColor.white.cgColor)
        cg.fill(CGRect(x: 0, y: 0, width: width, height: height))
        cg.scaleBy(x: scale, y: scale)
        cg.translateBy(x: -bounds.minX, y: -bounds.minY)
        page.draw(with: .mediaBox, to: cg)
        NSGraphicsContext.restoreGraphicsState()
        let properties: [NSBitmapImageRep.PropertyKey: Any] = format == "jpg" ? [.compressionFactor: 0.92] : [:]
        guard let data = bitmap.representation(using: format == "jpg" ? .jpeg : .png, properties: properties) else { fail("Could not encode page image") }
        let name = String(format: "page-%03d.%@", i + 1, format)
        do { try data.write(to: URL(fileURLWithPath: args[3]).appendingPathComponent(name)) } catch { fail(error.localizedDescription) }
        FileHandle.standardError.write(Data("PAGE \(i + 1) \(doc.pageCount)\n".utf8))
        }
    }
default: fail("Unknown PDF operation")
}
