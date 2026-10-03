import XCTest
import ImageIO
import UniformTypeIdentifiers
import PDFKit
import AVFoundation
import ZIPFoundation
@testable import OfflineKit

final class ConversionTests: XCTestCase {
    var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    func file(_ name: String, _ text: String) throws -> URL {
        let url = root.appendingPathComponent(name); try text.write(to: url, atomically: false, encoding: .utf8); return url
    }
    func convert(_ input: URL, _ target: String, name: String = "My result", options: ConversionOptions = ConversionOptions()) async throws -> LocalResult {
        try await OfflineEngine.convert(inputs: [input], target: target, name: name, options: options)
    }
    func testPNGtoJPEGandPDF() async throws {
        let input = root.appendingPathComponent("transparent.png")
        let context = CGContext(data: nil, width: 64, height: 32, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 0.5)); context.fill(CGRect(x: 0, y: 0, width: 64, height: 32))
        try ImagesPDF.write(context.makeImage()!, to: input, target: "png", quality: 1)
        let jpeg = try await convert(input, "jpg", name: "input-0")
        defer { jpeg.remove() }
        let source = CGImageSourceCreateWithURL(jpeg.url as CFURL, nil)!
        XCTAssertEqual(CGImageSourceGetType(source)! as String, UTType.jpeg.identifier)
        XCTAssertEqual(CGImageSourceCreateImageAtIndex(source, 0, nil)?.width, 64)
        XCTAssertTrue(FileManager.default.fileExists(atPath: input.path))
        let pdf = try await convert(input, "pdf"); defer { pdf.remove() }
        XCTAssertEqual(PDFDocument(url: pdf.url)?.pageCount, 1)
        let rendered = try await convert(pdf.url, "png"); defer { rendered.remove() }
        XCTAssertNotNil(CGImageSourceCreateWithURL(rendered.url as CFURL, nil))
    }
    func testDocumentRoundTripsAndUnicodePDF() async throws {
        let original = "A <document> & test\n日本語 and emoji 😀\nLast line"
        let input = try file("sample.txt", original)
        for format in ["docx", "odt", "html", "rtf"] {
            let packed = try await convert(input, format); defer { packed.remove() }
            let text = try await convert(packed.url, "txt"); defer { text.remove() }
            XCTAssertEqual(try String(contentsOf: text.url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), original, format)
        }
        let epub = try await convert(input, "epub"); defer { epub.remove() }
        let extracted = try await convert(epub.url, "txt"); defer { extracted.remove() }
        XCTAssertTrue(try String(contentsOf: extracted.url, encoding: .utf8).contains("日本語"))
        let pdf = try await convert(input, "pdf"); defer { pdf.remove() }
        XCTAssertTrue(PDFDocument(url: pdf.url)?.string?.contains("日本語") == true)
    }
    func testCSVJSONYAMLRoundTrip() async throws {
        let csv = try file("data.csv", "name,note\r\nAlice,\"comma, and \"\"quote\"\"\"\r\nBob,\"multi\nline\"\r\n")
        let json = try await convert(csv, "json"); defer { json.remove() }
        let records = try JSONSerialization.jsonObject(with: Data(contentsOf: json.url)) as! [[String: String]]
        XCTAssertEqual(records.count, 2); XCTAssertEqual(records[0]["note"], "comma, and \"quote\"")
        let yaml = try await convert(json.url, "yaml"); defer { yaml.remove() }
        let restored = try await convert(yaml.url, "json"); defer { restored.remove() }
        XCTAssertEqual(try Data(contentsOf: json.url), try Data(contentsOf: restored.url))
        let table = try await convert(json.url, "tsv"); defer { table.remove() }
        let tableJSON = try await convert(table.url, "json"); defer { tableJSON.remove() }
        XCTAssertEqual(try Data(contentsOf: json.url), try Data(contentsOf: tableJSON.url))
    }
    func testStyledDOCXPreservesPDFTablesImagesAndHTMLFonts() async throws {
        let url = root.appendingPathComponent("styled.docx")
        let archive = try Archive(url: url, accessMode: .create)
        try Archives.add("""
        <w:document xmlns:w="urn:word" xmlns:a="urn:drawing" xmlns:r="urn:relationships" xmlns:wp="urn:dimensions"><w:body>
        <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="753FCB"/></w:rPr><w:t>Styled document</w:t></w:r></w:p>
        <w:p><w:r><w:t>Normal paragraph with </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>italic emphasis</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Example</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:p><w:r><w:drawing><wp:inline><wp:extent cx="1524000" cy="762000"/><a:graphic><a:blip r:embed="image1"/></a:graphic></wp:inline></w:drawing></w:r></w:p>
        <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
        </w:body></w:document>
        """, name: "word/document.xml", archive: archive)
        try Archives.add("<Relationships><Relationship Id=\"image1\" Target=\"media/image.png\"/></Relationships>", name: "word/_rels/document.xml.rels", archive: archive)
        let imageURL = root.appendingPathComponent("image.png")
        let context = CGContext(data: nil, width: 128, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(red: 0.3, green: 0.2, blue: 0.8, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 128, height: 64))
        try ImagesPDF.write(context.makeImage()!, to: imageURL, target: "png", quality: 1)
        let imageData = try Data(contentsOf: imageURL)
        try archive.addEntry(with: "word/media/image.png", type: .file, uncompressedSize: Int64(imageData.count)) { position, count in imageData.subdata(in: Int(position)..<min(imageData.count, Int(position) + count)) }
        let pdf = try await convert(url, "pdf"); defer { pdf.remove() }
        let document = PDFDocument(url: pdf.url)!
        XCTAssertTrue(document.string?.contains("Styled document") == true)
        XCTAssertTrue(document.string?.contains("Example") == true)
        let html = try await convert(url, "html"); defer { html.remove() }
        let markup = try String(contentsOf: html.url, encoding: .utf8)
        XCTAssertTrue(markup.contains("font-weight:bold")); XCTAssertTrue(markup.contains("font-style:italic"))
        XCTAssertTrue(markup.contains("data:image/png;base64,")); XCTAssertTrue(markup.contains("<table"))
        let receipt = root.deletingLastPathComponent().appendingPathComponent("flux-styled-document.pdf")
        try? FileManager.default.removeItem(at: receipt); try FileManager.default.copyItem(at: pdf.url, to: receipt)
        let preview = root.deletingLastPathComponent().appendingPathComponent("flux-styled-document.png")
        try ImagesPDF.write(ImagesPDF.render(document.page(at: 0)!, scale: 1), to: preview, target: "png", quality: 1)
        do { _ = try await convert(url, "rtf"); XCTFail("RTF must not drop table/image contents") } catch { XCTAssertTrue(error.localizedDescription.contains("images/tables")) }
    }
    func testZIPRoundTripAndNames() async throws {
        let a = try file("first.weird-format", "hello"), b = try file("日本語.txt", "world")
        let archive = try await OfflineEngine.convert(inputs: [a, b], target: "zip", name: "Shared files", options: ConversionOptions())
        defer { archive.remove() }
        let unpacked = try await convert(archive.url, "unzip", name: "Extracted")
        defer { unpacked.remove() }
        XCTAssertTrue(unpacked.isDirectory)
        XCTAssertEqual(try String(contentsOf: unpacked.url.appendingPathComponent(a.lastPathComponent), encoding: .utf8), "hello")
        XCTAssertEqual(try String(contentsOf: unpacked.url.appendingPathComponent(b.lastPathComponent), encoding: .utf8), "world")
        XCTAssertThrowsError(try LocalPolicy.safeName("../../escape", extension: "zip"))
    }
    func testHostileZIPPathsAndExpansionAreRejected() throws {
        for path in ["../escaped", "/absolute", "a/../../escaped", "C:\\payload", "safe/./file", "foo\0bar"] {
            let url = root.appendingPathComponent(UUID().uuidString + ".zip")
            let archive = try Archive(url: url, accessMode: .create)
            try Archives.add("content", name: path, archive: archive)
            XCTAssertThrowsError(try Archives.validate(archive, control: JobControl()), path)
        }
        let url = root.appendingPathComponent("bomb.zip"), archive = try Archive(url: url, accessMode: .create)
        try Archives.add(String(repeating: "a", count: 1_000_000), name: "large", archive: archive)
        XCTAssertThrowsError(try Archives.validate(archive, control: JobControl()))
    }
    func testAliasAndXMLAttackRejection() async throws {
        let yaml = try file("alias.yaml", "a: &a [a, b]\nb: [*a, *a]\n")
        do { _ = try await convert(yaml, "json"); XCTFail("YAML aliases must be refused") } catch { XCTAssertTrue(error.localizedDescription.contains("aliases")) }
        let doc = root.appendingPathComponent("evil.docx"), archive = try Archive(url: doc, accessMode: .create)
        try Archives.add("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><w:document xmlns:w='urn:x'><w:t>&e;</w:t></w:document>", name: "word/document.xml", archive: archive)
        do { _ = try await convert(doc, "txt"); XCTFail("External XML entities must be refused") } catch { XCTAssertTrue(error.localizedDescription.contains("entities")) }
    }
    func testCancellationAndInvalidFilesLeaveNoWorkingFiles() async throws {
        let input = try file("bad.png", "not an image")
        let before = (try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? []
        do { _ = try await convert(input, "jpg"); XCTFail("Invalid image must fail") } catch {}
        let job = JobControl(); job.cancel()
        do { _ = try await OfflineEngine.convert(inputs: [input], target: "jpg", name: "cancelled", options: ConversionOptions(), control: job); XCTFail("Cancelled job must fail") } catch { XCTAssertTrue(error is LocalError) }
        XCTAssertEqual(Set((try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? []), Set(before))
    }
    func testPCMtoLosslessALACAndBack() async throws {
        let input = root.appendingPathComponent("tone.wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4410)!
        buffer.frameLength = 4410
        for i in 0..<4410 { buffer.floatChannelData![0][i] = sin(Float(i) * 0.05) * 0.5 }
        try autoreleasepool {
            let writer = try AVAudioFile(forWriting: input, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
            try writer.write(from: buffer)
        }
        let alac = try await convert(input, "m4a"); defer { alac.remove() }
        let decoded = try await convert(alac.url, "wav"); defer { decoded.remove() }
        let reader = try AVAudioFile(forReading: decoded.url)
        XCTAssertEqual(reader.length, 4410)
        XCTAssertEqual(reader.processingFormat.sampleRate, 44100)
    }
    func testLocalMP4MKVRemux() async throws {
        let input = ProcessInfo.processInfo.environment["FLUX_MEDIA_FIXTURE"].map { URL(fileURLWithPath: $0) } ?? Bundle.module.url(forResource: "remux", withExtension: "mp4")!
        let mkv = try await convert(input, "mkv"); defer { mkv.remove() }
        XCTAssertEqual(Array(try Data(contentsOf: mkv.url).prefix(4)), [0x1a, 0x45, 0xdf, 0xa3])
        let restored = try await convert(mkv.url, "mp4"); defer { restored.remove() }
        XCTAssertTrue(try Data(contentsOf: restored.url).prefix(32).contains(0x66))
        // Preserve artifacts for independent ffprobe packet/track verification.
        for (source, name) in [(mkv.url, "flux-tested-remux.mkv"), (restored.url, "flux-tested-remux.mp4")] {
            let destination = root.deletingLastPathComponent().appendingPathComponent(name)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.copyItem(at: source, to: destination)
        }
    }
}
