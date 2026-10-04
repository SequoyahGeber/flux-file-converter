import XCTest
import ZIPFoundation
@testable import OfflineKit

final class AuditFixTests: XCTestCase {
    var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    func text(_ name: String, _ value: String) throws -> URL {
        let url = root.appendingPathComponent(name); try value.write(to: url, atomically: false, encoding: .utf8); return url
    }
    func convert(_ input: URL, _ target: String) async throws -> LocalResult {
        try await OfflineEngine.convert(inputs: [input], target: target, name: "Regression", options: ConversionOptions())
    }
    func testDOCXMathAndUnsupportedInlineContentRejectWithoutChangingOriginal() async throws {
        for (index, content) in [#"<m:oMath><m:r><m:t>x + 2 = 3</m:t></m:r></m:oMath>"#, #"<m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>"#, #"<w:r><w:instrText>FORMULA</w:instrText></w:r>"#, #"<w:ins><w:r><w:t>Tracked content</w:t></w:r></w:ins>"#].enumerated() {
            let url = root.appendingPathComponent("equation-\(index).docx"), archive = try Archive(url: url, accessMode: .create)
            try Archives.add(#"<w:document xmlns:w="urn:word" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><w:r><w:t>Total: </w:t></w:r>"# + content + "</w:p></w:body></w:document>", name: "word/document.xml", archive: archive)
            let original = try Data(contentsOf: url)
            for target in ["pdf", "html", "rtf"] {
                do { let result = try await convert(url, target); defer { result.remove() }; XCTFail("Unsupported content published to \(target)") }
                catch { XCTAssertTrue(error.localizedDescription.contains("support"), error.localizedDescription) }
            }
            XCTAssertEqual(try Data(contentsOf: url), original)
        }
    }
    func testCompressedZIPFallsBackToStoredAndStillRejectsHostileExpansion() async throws {
        let input = try text("repeat.txt", String(repeating: "A", count: 1024 * 1024))
        let result = try await convert(input, "zip"); defer { result.remove() }
        let archive = try Archive(url: result.url, accessMode: .read)
        let entry = try XCTUnwrap(archive["repeat.txt"])
        XCTAssertEqual(entry.uncompressedSize, entry.compressedSize)
        let expanded = try await convert(result.url, "unzip"); defer { expanded.remove() }
        XCTAssertEqual(try Data(contentsOf: expanded.url.appendingPathComponent("repeat.txt")), try Data(contentsOf: input))
        let hostile = try Archive(url: root.appendingPathComponent("hostile.zip"), accessMode: .create)
        try Archives.add(String(repeating: "A", count: 1024 * 1024), name: "repeat.txt", archive: hostile)
        XCTAssertThrowsError(try Archives.validate(hostile, control: JobControl()))
    }
    func testZIPTotalsRejectBeforeReadingOrCreatingOutput() throws {
        var inputs: [URL] = []
        for name in ["a.bin", "b.bin"] {
            let url = root.appendingPathComponent(name)
            FileManager.default.createFile(atPath: url.path, contents: nil)
            let handle = try FileHandle(forWritingTo: url); try handle.truncate(atOffset: 600 * 1024 * 1024); try handle.close(); inputs.append(url)
        }
        let output = root.appendingPathComponent("too-large.zip")
        XCTAssertThrowsError(try Archives.zip(inputs, names: ["a.bin", "b.bin"], output: output, compress: false, control: JobControl()))
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }
    func epub(_ spine: String, href: String = "../chapters/z%20first.xhtml", duplicate: Bool = false) throws -> URL {
        let url = root.appendingPathComponent(UUID().uuidString + ".epub"), archive = try Archive(url: url, accessMode: .create)
        try Archives.add(#"<container><rootfiles><rootfile full-path="OPS/package/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#, name: "META-INF/container.xml", archive: archive)
        let manifest = "<item id='first' href='\(href)' media-type='application/xhtml+xml'/><item id='second' href='../chapters/a-second.xhtml' media-type='application/xhtml+xml'/><item id='nav' href='../nav.xhtml' media-type='application/xhtml+xml' properties='nav'/>" + (duplicate ? "<item id='first'/>" : "")
        try Archives.add("<package><manifest>" + manifest + "</manifest><spine>" + spine + "</spine></package>", name: "OPS/package/content.opf", archive: archive)
        try Archives.add("<html><body><p>FIRST CHAPTER 日本語</p></body></html>", name: "OPS/chapters/z first.xhtml", archive: archive)
        try Archives.add("<html><body><p>SECOND CHAPTER</p></body></html>", name: "OPS/chapters/a-second.xhtml", archive: archive)
        try Archives.add("<html><body><nav>CONTENTS NAVIGATION</nav></body></html>", name: "OPS/nav.xhtml", archive: archive)
        return url
    }
    func testEPUBUsesSpineOrderAndExcludesNavigationAndNonlinearItems() async throws {
        let input = try epub("<itemref idref='first'/><itemref idref='nav' linear='no'/><itemref idref='second'/>")
        for target in ["txt", "md"] {
            let result = try await convert(input, target); defer { result.remove() }
            XCTAssertEqual(try String(contentsOf: result.url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), "FIRST CHAPTER 日本語\n\nSECOND CHAPTER")
        }
        for input in [try epub("<itemref idref='missing'/>"), try epub("<itemref idref='first'/>", href: "https://example.invalid/chapter"), try epub("<itemref idref='first'/>", href: "../../../escape.xhtml"), try epub("<itemref idref='first'/>", duplicate: true)] {
            do { let result = try await convert(input, "txt"); defer { result.remove() }; XCTFail("Invalid EPUB succeeded") }
            catch { XCTAssertTrue(error is LocalError) }
        }
        XCTAssertThrowsError(try EPUB.resolve("%2e%2e/%2e%2e/escape.xhtml", base: "OPS"))
    }
    func testSubtitleCueSerializationPreservesShortTimestampsTextAndIndices() async throws {
        let input = try text("short.vtt", "WEBVTT\r\n\r\nNOTE skipped comment\r\n\r\nintro\r\n00:01.000 --> 00:02.250 align:start\r\nHello 日本語\r\n\r\n00:00:03.000 --> 00:00:04.000\r\nSecond cue\r\n")
        let srt = try await convert(input, "srt"); defer { srt.remove() }
        XCTAssertEqual(try String(contentsOf: srt.url, encoding: .utf8), "1\n00:00:01,000 --> 00:00:02,250\nHello 日本語\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond cue\n\n")
        let vtt = try await convert(srt.url, "vtt"); defer { vtt.remove() }
        XCTAssertEqual(try String(contentsOf: vtt.url, encoding: .utf8), "WEBVTT\n\n00:00:01.000 --> 00:00:02.250\nHello 日本語\n\n00:00:03.000 --> 00:00:04.000\nSecond cue\n\n")
        let plain = try await convert(input, "txt"); defer { plain.remove() }
        XCTAssertEqual(try String(contentsOf: plain.url, encoding: .utf8), "Hello 日本語\n\nSecond cue\n")
        for source in ["WEBVTT\n\n00:61.000 --> 00:62.000\nBad\n", "WEBVTT\n\n00:02.000 --> 00:01.000\nBad\n", "WEBVTT\n\nSTYLE\n::cue {color:red}\n"] {
            XCTAssertThrowsError(try Subtitles.convert(source, fromVTT: true, target: "srt"))
        }
    }
}
