import Foundation
import ImageIO
import PDFKit
import CoreText
import UniformTypeIdentifiers

enum ImagesPDF {
    static func image(_ input: URL) throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(input as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 30000, height <= 30000, Int64(width) * Int64(height) <= 24_000_000 else {
            throw LocalError.invalid("Invalid image or image larger than 24 megapixels.")
        }
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(width, height), kCGImageSourceShouldCacheImmediately: false
        ] as CFDictionary) else { throw LocalError.invalid("This image codec cannot be decoded on this device.") }
        return image
    }
    static func write(_ original: CGImage, to output: URL, target: String, quality: Double) throws {
        guard let type = UTType(filenameExtension: target),
              let destination = CGImageDestinationCreateWithURL(output as CFURL, type.identifier as CFString, 1, nil) else {
            throw LocalError.unsupported
        }
        var image = original
        if target == "jpg" || target == "jpeg" {
            guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
                bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw LocalError.unsupported }
            context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            guard let flattened = context.makeImage() else { throw LocalError.unsupported }; image = flattened
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw LocalError.invalid("The image encoder could not write this file.") }
    }
    static func render(_ page: PDFPage, scale: Double) throws -> CGImage {
        let box = page.bounds(for: .mediaBox)
        guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0 else { throw LocalError.invalid("Invalid PDF page size.") }
        let actual = min(scale, 4096 / max(box.width, box.height))
        let width = max(1, Int(box.width * actual)), height = max(1, Int(box.height * actual))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw LocalError.unsupported }
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: actual, y: actual); context.translateBy(x: -box.minX, y: -box.minY)
        page.draw(with: .mediaBox, to: context)
        guard let image = context.makeImage() else { throw LocalError.unsupported }; return image
    }
    static func pdf(_ input: URL) throws -> PDFDocument {
        guard let document = PDFDocument(url: input), !document.isLocked, document.pageCount > 0, document.pageCount <= 200 else {
            throw LocalError.invalid("Choose an unlocked PDF with between 1 and 200 pages.")
        }
        return document
    }
    static func convert(_ input: URL, output: URL, target: String, options: ConversionOptions, control: JobControl) throws {
        try control.check()
        if input.pathExtension.lowercased() == "pdf" {
            let document = try pdf(input)
            if target == "txt" {
                var text = ""
                for index in 0..<document.pageCount {
                    try control.check(); text += (document.page(at: index)?.string ?? "") + "\n\n"
                    if text.utf8.count > LocalPolicy.textLimit { throw LocalError.invalid("Extracted text exceeds 16 MB.") }
                }
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LocalError.invalid("This PDF has no selectable text. Local OCR is not available.") }
                try text.write(to: output, atomically: false, encoding: .utf8)
            } else if target == "pdf" {
                guard let context = CGContext(output as CFURL, mediaBox: nil, nil) else { throw LocalError.unsupported }
                for index in 0..<document.pageCount {
                    try autoreleasepool {
                    try control.check()
                    guard let page = document.page(at: index) else { throw LocalError.invalid("A PDF page could not be read.") }
                    let rendered = try render(page, scale: 1)
                    let jpeg = NSMutableData()
                    guard let destination = CGImageDestinationCreateWithData(jpeg, UTType.jpeg.identifier as CFString, 1, nil) else { throw LocalError.unsupported }
                    CGImageDestinationAddImage(destination, rendered, [kCGImageDestinationLossyCompressionQuality: options.quality] as CFDictionary)
                    guard CGImageDestinationFinalize(destination), let provider = CGDataProvider(data: jpeg),
                          let compressed = CGImage(jpegDataProviderSource: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { throw LocalError.unsupported }
                    drawPDFPage(compressed, box: page.bounds(for: .mediaBox), context: context)
                    }
                }
                context.closePDF()
            } else {
                guard let page = document.page(at: 0) else { throw LocalError.unsupported }
                try write(render(page, scale: 2), to: output, target: target, quality: options.quality)
            }
        } else {
            let decoded = try image(input)
            if target == "pdf" {
                guard let context = CGContext(output as CFURL, mediaBox: nil, nil) else { throw LocalError.unsupported }
                drawPDFPage(decoded, box: CGRect(x: 0, y: 0, width: decoded.width, height: decoded.height), context: context)
                context.closePDF()
            } else { try write(decoded, to: output, target: target, quality: options.quality) }
        }
        try control.check()
    }
    static func drawPDFPage(_ image: CGImage, box: CGRect, context: CGContext) {
        var bounds = CGRect(origin: .zero, size: box.size)
        let data = Data(bytes: &bounds, count: MemoryLayout<CGRect>.size)
        context.beginPDFPage([kCGPDFContextMediaBox as String: data] as CFDictionary)
        context.draw(image, in: bounds); context.endPDFPage()
    }
    static func textPDF(_ text: String, to output: URL, control: JobControl) throws {
        guard let context = CGContext(output as CFURL, mediaBox: nil, nil) else { throw LocalError.unsupported }
        let attributed = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica" as CFString, 12, nil)])
        let setter = CTFramesetterCreateWithAttributedString(attributed)
        var start = 0, pages = 0
        repeat {
            try control.check(); pages += 1
            if pages > 500 { throw LocalError.invalid("Text exceeds the 500-page PDF limit.") }
            var box = CGRect(x: 0, y: 0, width: 612, height: 792)
            context.beginPDFPage([kCGPDFContextMediaBox as String: Data(bytes: &box, count: MemoryLayout<CGRect>.size)] as CFDictionary)
            let path = CGPath(rect: CGRect(x: 36, y: 36, width: 540, height: 720), transform: nil)
            let frame = CTFramesetterCreateFrame(setter, CFRange(location: start, length: 0), path, nil)
            CTFrameDraw(frame, context); context.endPDFPage()
            let range = CTFrameGetVisibleStringRange(frame)
            if range.length == 0 && start < attributed.length { throw LocalError.invalid("Text could not be laid out.") }
            start += range.length
        } while start < attributed.length
        context.closePDF()
    }
}
