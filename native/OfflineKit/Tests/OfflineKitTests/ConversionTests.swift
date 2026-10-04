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
    func testLargeStoredZIPRoundTrip() async throws {
        let input = root.appendingPathComponent("large.bin")
        FileManager.default.createFile(atPath: input.path, contents: nil)
        let file = try FileHandle(forWritingTo: input)
        try file.truncate(atOffset: 256 * 1024 * 1024)
        try file.close()
        var options = ConversionOptions(); options.compressArchive = false
        let archive = try await convert(input, "zip", options: options); defer { archive.remove() }
        let extracted = try await convert(archive.url, "unzip"); defer { extracted.remove() }
        let restored = extracted.url.appendingPathComponent("large.bin")
        XCTAssertEqual(try LocalPolicy.fileSize(restored), 256 * 1024 * 1024)
        let reader = try FileHandle(forReadingFrom: restored); defer { try? reader.close() }
        try reader.seek(toOffset: 256 * 1024 * 1024 - 16)
        XCTAssertEqual(try reader.read(upToCount: 16), Data(repeating: 0, count: 16))
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
    func testBundledReviewerSamplesUseRealConversionsAndPreserveInputs() async throws {
        for sample in ReviewResources.samples {
            let url = try XCTUnwrap(sample.url, sample.filename)
            let original = try Data(contentsOf: url)
            let result = try await convert(url, sample.target, name: "Reviewer result")
            if sample.target == "pdf" {
                XCTAssertTrue(PDFDocument(url: result.url)?.string?.contains("Flux sample document") == true)
            } else if sample.target == "unzip" {
                XCTAssertEqual(try String(contentsOf: result.url.appendingPathComponent("Read me.txt"), encoding: .utf8), "Fictional review files. No personal data.\n")
            } else { XCTAssertGreaterThan(try LocalPolicy.fileSize(result.url), 0) }
            result.remove()
            XCTAssertEqual(try Data(contentsOf: url), original, "Sample input must stay unchanged after conversion and cleanup")
        }
        XCTAssertTrue(ReviewResources.privacyText.contains("collect no personal information"))
        XCTAssertTrue(ReviewResources.supportText.contains("No Unraid connection"))
    }
    func testPDFtoPNGKeepsOriginalThroughCancellationFailureAndCleanup() async throws {
        let text = try file("Original.txt", "Original PDF remains intact.\nSecond line.")
        let generated = try await convert(text, "pdf", name: "Original")
        let pdf = root.appendingPathComponent("Original.pdf")
        try FileManager.default.copyItem(at: generated.url, to: pdf); generated.remove()
        let original = try Data(contentsOf: pdf)
        let image = try await convert(pdf, "png", name: "Original")
        XCTAssertEqual(image.url.lastPathComponent, "Original.png")
        XCTAssertEqual(try Data(contentsOf: pdf), original)
        let saved = root.appendingPathComponent("Original.png")
        try FileManager.default.copyItem(at: image.url, to: saved); image.remove()
        let cancelled = JobControl(); cancelled.cancel()
        do { _ = try await OfflineEngine.convert(inputs: [pdf], target: "png", name: "Cancelled", options: ConversionOptions(), control: cancelled); XCTFail("Cancelled job succeeded") }
        catch { XCTAssertTrue(error is LocalError) }
        do { _ = try await convert(pdf, "png", name: "../../Original"); XCTFail("Unsafe name succeeded") }
        catch { XCTAssertTrue(error is LocalError) }
        OfflineEngine.clearTemporaryFiles()
        XCTAssertEqual(try Data(contentsOf: pdf), original)
        XCTAssertNotNil(CGImageSourceCreateWithURL(saved as CFURL, nil))
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
    func testExtractionNameCannotCollideWithStagedInputs() async throws {
        let input = try file("source.txt", "kept")
        let zip = try await convert(input, "zip"); defer { zip.remove() }
        let extracted = try await convert(zip.url, "unzip", name: "inputs"); defer { extracted.remove() }
        XCTAssertEqual(extracted.url.lastPathComponent, "inputs")
        XCTAssertEqual(try String(contentsOf: extracted.url.appendingPathComponent("source.txt"), encoding: .utf8), "kept")
    }
    func testCopyRejectsLinksAndPreservesExistingDestinations() throws {
        let source = try file("source.txt", "source"), destination = try file("destination.txt", "original")
        XCTAssertThrowsError(try LocalPolicy.copy(source, to: destination, control: JobControl()))
        XCTAssertEqual(try String(contentsOf: destination, encoding: .utf8), "original")
        let link = root.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        XCTAssertThrowsError(try LocalPolicy.copy(link, to: root.appendingPathComponent("copy.txt"), control: JobControl()))
    }
    func testInvalidQualityDoesNotCreateWorkingFiles() async throws {
        let input = try file("input.txt", "test")
        let before = Set((try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? [])
        for quality in [Double.nan, Double.infinity, -1, 2] {
            var options = ConversionOptions(); options.quality = quality
            do { _ = try await convert(input, "zip", options: options); XCTFail("Invalid quality succeeded") }
            catch { XCTAssertTrue(error.localizedDescription.contains("Quality")) }
        }
        XCTAssertEqual(Set((try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? []), before)
    }
    func testCSVPreservesBooleansAndProtectsFormulaCells() async throws {
        let input = try file("data.json", #"[{"bool":true,"number":12,"text":"=1+1"},{"bool":false,"number":-3,"text":"+formula"}]"#)
        let csv = try await convert(input, "csv"); defer { csv.remove() }
        let rows = try StructuredData.parseCSV(String(contentsOf: csv.url, encoding: .utf8), separator: ",", control: JobControl())
        XCTAssertEqual(rows, [["bool", "number", "text"], ["true", "12", "'=1+1"], ["false", "-3", "'+formula"]])
    }
    func testCSVLimitsApplyToFinalRowWithoutNewline() throws {
        let columns = Array(repeating: "cell", count: 1001).joined(separator: ",")
        XCTAssertThrowsError(try StructuredData.parseCSV(columns, separator: ",", control: JobControl()))
        let rows = String(repeating: "cell\n", count: 100_000) + "last"
        XCTAssertThrowsError(try StructuredData.parseCSV(rows, separator: ",", control: JobControl()))
        let allowed = Array(repeating: "cell", count: 1000).joined(separator: ",")
        XCTAssertEqual(try StructuredData.parseCSV(allowed, separator: ",", control: JobControl())[0].count, 1000)
    }
    func testRepeatedDOCXImagesCannotExhaustDecodedMemory() async throws {
        let doc = root.appendingPathComponent("many-images.docx"), archive = try Archive(url: doc, accessMode: .create)
        let image = root.appendingPathComponent("image.png")
        let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        try ImagesPDF.write(context.makeImage()!, to: image, target: "png", quality: 1)
        let data = try Data(contentsOf: image)
        try archive.addEntry(with: "word/media/image.png", type: .file, uncompressedSize: Int64(data.count)) { position, count in
            data.subdata(in: Int(position)..<min(data.count, Int(position) + count))
        }
        let paragraph = #"<w:p><w:r><w:drawing><a:blip r:embed="image1"/></w:drawing></w:r></w:p>"#
        try Archives.add(#"<w:document xmlns:w="urn:word" xmlns:a="urn:drawing" xmlns:r="urn:rel"><w:body>"# +
                         String(repeating: paragraph, count: 17) + "</w:body></w:document>",
                         name: "word/document.xml", archive: archive, compressed: false)
        try Archives.add(#"<Relationships><Relationship Id="image1" Target="media/image.png"/></Relationships>"#,
                         name: "word/_rels/document.xml.rels", archive: archive)
        do { _ = try await convert(doc, "pdf"); XCTFail("Decoded image budget was bypassed") }
        catch { XCTAssertTrue(error.localizedDescription.contains("128 MB"), error.localizedDescription) }
    }
    func testFiftyThousandRecordTableConversion() async throws {
        let input = root.appendingPathComponent("large.csv")
        var data = Data("name,value\n".utf8)
        for i in 0..<50_000 { data.append(Data("row-\(i),\(i)\n".utf8)) }
        try data.write(to: input)
        let started = ProcessInfo.processInfo.systemUptime
        let json = try await convert(input, "json"); defer { json.remove() }
        let records = try JSONSerialization.jsonObject(with: Data(contentsOf: json.url)) as! [[String: String]]
        XCTAssertEqual(records.count, 50_000)
        XCTAssertEqual(records.last?["name"], "row-49999")
        let csv = try await convert(json.url, "csv"); defer { csv.remove() }
        let table = try StructuredData.parseCSV(String(contentsOf: csv.url, encoding: .utf8), separator: ",", control: JobControl())
        XCTAssertEqual(table.count, 50_001)
        XCTAssertEqual(table.last, ["row-49999", "49999"])
        print("Flux audit 50,000 record CSV/JSON round trip: \(ProcessInfo.processInfo.systemUptime - started) seconds")
    }
    func testScannedPDFTextExtractionReportsMissingText() async throws {
        let sample = try XCTUnwrap(ReviewResources.samples.first(where: { $0.id == "image" })?.url)
        let pdf = try await convert(sample, "pdf"); defer { pdf.remove() }
        do { _ = try await convert(pdf.url, "txt"); XCTFail("A scanned PDF produced a misleading empty result") }
        catch { XCTAssertTrue(error.localizedDescription.contains("no selectable text")) }
    }
    func testRepeatedConversionsReleaseTheirWorkingFolders() async throws {
        let input = try file("repeat.txt", "Repeated conversion 日本語\n")
        let before = Set((try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? [])
        for _ in 0..<50 {
            let document = try await convert(input, "docx")
            let text = try await convert(document.url, "txt")
            XCTAssertTrue(try String(contentsOf: text.url, encoding: .utf8).contains("日本語"))
            text.remove(); document.remove()
        }
        XCTAssertEqual(Set((try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? []), before)
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
    func testEncryptedSpecialAndUnreadableZIPEntriesRejectTheWholeArchive() async throws {
        let original = root.appendingPathComponent("original.zip")
        do {
            let archive = try Archive(url: original, accessMode: .create)
            try Archives.add("first contents", name: "first.txt", archive: archive, compressed: false)
            try Archives.add("second contents", name: "second.txt", archive: archive, compressed: false)
        }
        let data = try Data(contentsOf: original)
        let central = try XCTUnwrap(data.range(of: Data([0x50, 0x4b, 0x01, 0x02]))).lowerBound
        let first = try XCTUnwrap(data.range(of: Data([0x50, 0x4b, 0x03, 0x04]))).lowerBound
        let second = try XCTUnwrap(data.range(of: Data([0x50, 0x4b, 0x03, 0x04]), in: (first + 4)..<data.count)).lowerBound
        for kind in ["encrypted", "special", "unreadable"] {
            var modified = data
            if kind == "encrypted" { modified[central + 8] |= 1 }
            if kind == "special" { modified[central + 5] = 3; modified[central + 41] = 0x11 }
            if kind == "unreadable" { modified[second] = 0 }
            let input = root.appendingPathComponent(kind + ".zip"); try modified.write(to: input)
            let before = Set((try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? [])
            do { _ = try await convert(input, "unzip"); XCTFail("Partial or unsupported ZIP succeeded: \(kind)") }
            catch { XCTAssertTrue(error is LocalError, error.localizedDescription) }
            XCTAssertEqual(Set((try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? []), before)
        }
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
