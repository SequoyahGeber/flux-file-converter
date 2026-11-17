import XCTest
import ImageIO
import PDFKit
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
    func testYAMLDatesNonFiniteAndBinaryRefuseWithLocalErrorInsteadOfCrashing() async throws {
        let files = [("date.yaml", "- date: 2024-01-15\n"), ("nan.yaml", "- value: .nan\n"), ("inf.yaml", "- value: .inf\n"), ("neginf.yaml", "- value: -.inf\n"), ("bin.yaml", "- data: !!binary aGVsbG8=\n")]
        let jobs = { (try? FileManager.default.contentsOfDirectory(atPath: OfflineEngine.jobsDirectory.path)) ?? [] }
        let before = Set(jobs())
        for (name, content) in files {
            let input = try text(name, content)
            for target in ["json", "yaml", "csv"] {
                do { let result = try await convert(input, target); defer { result.remove() }; XCTFail("\(name) converted to \(target)") }
                catch let error as LocalError {
                    if case .cancelled = error { XCTFail("\(name) to \(target) reported cancellation") }
                    XCTAssertTrue(error.localizedDescription.contains("Quote the value"), error.localizedDescription)
                }
            }
        }
        XCTAssertEqual(Set(jobs()), before)
        let quoted = try await convert(try text("quoted.yaml", "- date: \"2024-01-15\"\n"), "json"); defer { quoted.remove() }
        let restored = try JSONSerialization.jsonObject(with: Data(contentsOf: quoted.url)) as? [[String: String]]
        XCTAssertEqual(restored, [["date": "2024-01-15"]])
    }
    func hugeUnclosedHead() -> String {
        String(repeating: "<head>x", count: 16_000) + String(repeating: "Plain words after the tags. ", count: 7500)
    }
    func testHugeUnclosedHeadTagsConvertQuickly() async throws {
        let input = try text("huge.html", hugeUnclosedHead())
        let start = ProcessInfo.processInfo.systemUptime
        let result = try await convert(input, "txt"); defer { result.remove() }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 2)
        XCTAssertTrue(try String(contentsOf: result.url, encoding: .utf8).hasSuffix("Plain words after the tags."))
    }
    func testHTMLStripCancelsPromptly() throws {
        let control = JobControl(); control.cancel()
        let start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try Documents.htmlText(hugeUnclosedHead(), control: control)) { error in
            guard case LocalError.cancelled = error else { return XCTFail("Expected cancellation, got \(error)") }
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 1)
    }
    func twoColourPDF(rotation: Int, origin: CGPoint = .zero) throws -> URL {
        let raw = root.appendingPathComponent("raw-\(rotation).pdf"), url = root.appendingPathComponent("two-colour-\(rotation).pdf")
        var box = CGRect(x: origin.x, y: origin.y, width: 200, height: 100)
        let context = try XCTUnwrap(CGContext(raw as CFURL, mediaBox: &box, nil))
        context.beginPDFPage(nil)
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1)); context.fill(CGRect(x: origin.x, y: origin.y, width: 100, height: 100))
        context.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1)); context.fill(CGRect(x: origin.x + 100, y: origin.y, width: 100, height: 100))
        context.endPDFPage(); context.closePDF()
        let document = try XCTUnwrap(PDFDocument(url: raw))
        try XCTUnwrap(document.page(at: 0)).rotation = rotation
        XCTAssertTrue(document.write(to: url))
        return url
    }
    func colourFractions(_ image: CGImage) throws -> (red: Double, blue: Double, white: Double) {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var red = 0, blue = 0, white = 0
        for offset in stride(from: 0, to: pixels.count, by: 4) {
            let r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2]
            if r > 180 && g < 90 && b < 90 { red += 1 } else if b > 180 && r < 90 && g < 90 { blue += 1 } else if r > 220 && g > 220 && b > 220 { white += 1 }
        }
        let total = Double(width * height)
        return (Double(red) / total, Double(blue) / total, Double(white) / total)
    }
    func decoded(_ url: URL) throws -> CGImage {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        return try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
    }
    func assertWhole(_ image: CGImage, portrait: Bool, _ label: String) throws {
        XCTAssertEqual(image.height > image.width, portrait, "\(label) orientation \(image.width)x\(image.height)")
        let fractions = try colourFractions(image)
        XCTAssertGreaterThanOrEqual(fractions.red, 0.4, "\(label) red \(fractions)")
        XCTAssertGreaterThanOrEqual(fractions.blue, 0.4, "\(label) blue \(fractions)")
        XCTAssertLessThanOrEqual(fractions.white, 0.1, "\(label) white \(fractions)")
    }
    func testRotatedPDFPagesRenderWholeToImagesAndSmallerPDF() async throws {
        for (rotation, origin) in [(0, CGPoint.zero), (90, .zero), (270, .zero), (0, CGPoint(x: 50, y: 30)), (90, CGPoint(x: 50, y: 30)), (270, CGPoint(x: 50, y: 30))] {
            let input = try twoColourPDF(rotation: rotation, origin: origin), portrait = rotation != 0
            for target in ["png", "jpg"] {
                let result = try await convert(input, target); defer { result.remove() }
                try assertWhole(try decoded(result.url), portrait: portrait, "\(target) rotation \(rotation) origin \(origin)")
            }
            let result = try await convert(input, "pdf"); defer { result.remove() }
            let page = try XCTUnwrap(PDFDocument(url: result.url)?.page(at: 0))
            let size = page.bounds(for: .mediaBox).applying(page.transform(for: .mediaBox))
            XCTAssertEqual(abs(size.height) > abs(size.width), portrait, "pdf rotation \(rotation) origin \(origin) page \(size)")
            try assertWhole(try ImagesPDF.render(page, scale: 2), portrait: portrait, "pdf rotation \(rotation) origin \(origin)")
        }
    }
    func testHTMLStripKeepsPreviousBehaviour() throws {
        let cases = [
            ("<html><head><title>T</title></head><body><script>x</script><p>A</p><STYLE type=t>y</style ><p>B</p></body></html>", "A\nB"),
            ("<header>Title</header>", "Title"),
            ("<script>keep me", "keep me"),
            ("<head>a<script>b</script>c", "ac"),
            ("<script><script>x</script>y</script>", "y"),
            ("<SCRIPT>x</Script\t\n>after", "after"),
            ("<scripts>kept</scripts>", "kept"),
            ("<style/>tail", "tail"),
            ("<head>a</head >b", "b"),
            ("<script>x</scriptx>y", "xy"),
            ("", ""),
            ("text <", "text <"),
            ("<p>日本語のテキスト</p><script>削除</script><p>残る</p>", "日本語のテキスト\n残る"),
        ]
        for (source, expected) in cases {
            XCTAssertEqual(try Documents.htmlText(source, control: JobControl()), expected, source)
        }
    }
    // FX-B-04: a deliberate cancel and a deadline are different outcomes, and the deadline message states its limit.
    func testCancelAndDeadlineAreDistinct() {
        let stopped = JobControl(); stopped.cancel()
        XCTAssertThrowsError(try stopped.check()) { error in
            guard case LocalError.cancelled = error else { return XCTFail("Expected cancellation, got \(error)") }
            XCTAssertEqual(error.localizedDescription, "Conversion cancelled.")
        }
        XCTAssertTrue(stopped.wasCancelled)
        let expired = JobControl(deadline: -1)
        XCTAssertTrue(expired.isCancelled); XCTAssertFalse(expired.wasCancelled)
        XCTAssertThrowsError(try expired.check()) { error in
            guard case LocalError.timedOut = error else { return XCTFail("Expected a timeout, got \(error)") }
        }
        XCTAssertTrue(LocalError.timedOut(600).localizedDescription.hasPrefix("Stopped after 10 minutes,"))
        XCTAssertTrue(LocalError.timedOut(2 * 60 * 60 + 600).localizedDescription.hasPrefix("Stopped after 2 hours 10 minutes,"))
        XCTAssertEqual(LocalError.duration(60 * 60), "1 hour")
    }
    // FX-A-08: the tag strip matches the old regex and stays linear on unclosed "<".
    func testTagStripMatchesTheRegexAndIsLinear() throws {
        let long = String(repeating: "x", count: 4097)
        for source in ["a<b>c", "<p>one</p><br/>two", "x < y > z", "<<a>>", "no tags", "<open", "a<\(long)>b", "a<\(long.dropLast())>b", "é<i>ü</i>ß"] {
            let regex = source.replacingOccurrences(of: "<[^>]{0,4096}>", with: "", options: .regularExpression)
            XCTAssertEqual(try Documents.stripTags(source, control: JobControl()), regex, source)
        }
        let hostile = String(repeating: "<", count: 16 * 1024 * 1024 - 2) + ">"
        let start = ProcessInfo.processInfo.systemUptime
        _ = try Documents.stripTags(hostile, control: JobControl())
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 5)
        let stopped = JobControl(); stopped.cancel()
        XCTAssertThrowsError(try Documents.stripTags(hostile, control: stopped))
    }
}

/// FX-A-09: names Flux derives from ordinary file names never fail a rule the person didn't break; typed names stay
/// strict and say which rule failed.
final class NameRuleTests: XCTestCase {
    var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    func testDerivedDefaultNamesAlwaysPassTheNameRules() throws {
        let long = String(repeating: "日本語", count: 30)  // 270 bytes
        let cases: [(String, String)] = [
            ("Report 1:2.pdf", "Report 1-2-converted"),  // Finder shows ":" as "/"
            (".notes.txt", "notes-converted"),
            ("back\\slash.png", "back-slash-converted"),
            ("tab\there.jpg", "tabhere-converted"),
        ]
        for (file, expected) in cases {
            let name = LocalPolicy.defaultOutputName(for: root.appendingPathComponent(file))
            XCTAssertEqual(name, expected, file)
            XCTAssertNoThrow(try LocalPolicy.safeName(name, extension: "jpg"), file)
        }
        let cjk = LocalPolicy.defaultOutputName(for: root.appendingPathComponent(long + ".txt"))
        XCTAssertTrue(cjk.hasSuffix("-converted"))
        XCTAssertLessThanOrEqual(cjk.utf8.count, LocalPolicy.nameByteLimit)
        XCTAssertNoThrow(try LocalPolicy.safeName(cjk, extension: "pdf"))
    }

    func testTruncationNeverSplitsACharacter() {
        let family = "👨‍👩‍👧‍👦"  // one Character, 25 UTF-8 bytes
        let value = String(repeating: "a", count: 170) + family
        let cut = LocalPolicy.suggestedName(from: value)
        XCTAssertEqual(cut, String(repeating: "a", count: 170))
        XCTAssertEqual(LocalPolicy.suggestedName(from: String(repeating: "a", count: 155) + family), String(repeating: "a", count: 155) + family)
        XCTAssertEqual(LocalPolicy.suggestedName(from: " . "), "Converted")
        XCTAssertEqual(LocalPolicy.suggestedName(from: "..", suffix: "-converted"), "Converted")
    }

    func testTypedNamesSayWhichRuleFailed() {
        let expectations: [(String, String)] = [
            ("", "Enter a file name."),
            ("a/b", "File names can’t contain /, \\ or :."),
            ("a:b", "File names can’t contain /, \\ or :."),
            (".hidden", "File names can’t start with a dot."),
            ("..", "File names can’t start with a dot."),
            ("line\nbreak", "File names can’t contain line breaks or other control characters."),
            (String(repeating: "x", count: 181), "This name is too long. Use up to 180 letters (fewer in some languages)."),
        ]
        for (name, message) in expectations {
            XCTAssertEqual(LocalPolicy.nameProblem(name), message, name)
            XCTAssertThrowsError(try LocalPolicy.safeName(name, extension: "txt"), name) { error in
                XCTAssertEqual(error.localizedDescription, message)
            }
        }
        XCTAssertNil(LocalPolicy.nameProblem("Résumé – final (2)"))
        XCTAssertEqual(try LocalPolicy.safeName(" Report ", extension: "pdf"), "Report.pdf")
    }

    func testUniqueNamesNeverOverwrite() {
        var taken: Set<String> = ["photo.jpg", "photo 2.jpg", "Folder", ".env"]
        XCTAssertEqual(LocalPolicy.uniqueName("photo.jpg") { taken.contains($0) }, "photo 3.jpg")
        XCTAssertEqual(LocalPolicy.uniqueName("Folder", isDirectory: true) { taken.contains($0) }, "Folder 2")
        XCTAssertEqual(LocalPolicy.uniqueName(".env") { taken.contains($0) }, ".env 2")
        taken = []
        XCTAssertEqual(LocalPolicy.uniqueName("new.txt") { taken.contains($0) }, "new.txt")
    }

    func testZIPPacksAwkwardAndCollidingNamesAndExtractionStaysStrict() async throws {
        let dir = root.appendingPathComponent("sources"), other = root.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        let colon = dir.appendingPathComponent("a:b.txt"), dash = dir.appendingPathComponent("a-b.txt")
        let backslash = dir.appendingPathComponent("c\\d.txt"), same = other.appendingPathComponent("A-B.txt")
        for (url, text) in [(colon, "colon"), (dash, "dash"), (backslash, "backslash"), (same, "same")] {
            try text.write(to: url, atomically: false, encoding: .utf8)
        }
        let zip = try await OfflineEngine.convert(inputs: [colon, dash, backslash, same], target: "zip", name: "Packed", options: ConversionOptions())
        defer { zip.remove() }
        let archive = try Archive(url: zip.url, accessMode: .read)
        XCTAssertEqual(Set(archive.map(\.path)), ["a-b.txt", "a-b 2.txt", "c-d.txt", "A-B 3.txt"])
        let unpacked = try await OfflineEngine.convert(inputs: [zip.url], target: "unzip", name: "Unpacked", options: ConversionOptions())
        defer { unpacked.remove() }
        XCTAssertEqual(try String(contentsOf: unpacked.url.appendingPathComponent("a-b 2.txt"), encoding: .utf8), "dash")
        XCTAssertThrowsError(try Archives.path("x:y.txt"))
        XCTAssertThrowsError(try Archives.path("x\\y.txt"))
    }

    func testCaseOnlyRenameAndRealCollisions() throws {
        let job = root.appendingPathComponent("job"); try FileManager.default.createDirectory(at: job, withIntermediateDirectories: true)
        let original = job.appendingPathComponent("A-converted.jpg"); try Data("x".utf8).write(to: original)
        let other = job.appendingPathComponent("other.jpg"); try Data("y".utf8).write(to: other)
        let result = LocalResult(url: original, directory: job)
        XCTAssertThrowsError(try result.renamed(to: "other.jpg")) { XCTAssertEqual($0.localizedDescription, "This result name already exists. Choose a different name.") }
        let renamed = try result.renamed(to: "a-converted.jpg")
        XCTAssertEqual(renamed.url.lastPathComponent, "a-converted.jpg")
        let listed = try FileManager.default.contentsOfDirectory(atPath: job.path)
        XCTAssertTrue(listed.contains("a-converted.jpg"), "\(listed)")
        XCTAssertFalse(listed.contains("A-converted.jpg"), "\(listed)")
        XCTAssertEqual(try Data(contentsOf: renamed.url), Data("x".utf8))
    }
}

/// FX-B-16: files opened in Flux from another app are kept only as private copies, and those copies go away.
final class OpenedFilesTests: XCTestCase {
    var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    func testInboxCopiesMoveOtherFilesCopyAndDiscardOnlyTouchesPrivateCopies() throws {
        let fm = FileManager.default
        let container = root.appendingPathComponent("container"), inbox = container.appendingPathComponent("Documents/Inbox")
        let opened = root.appendingPathComponent("opened"), elsewhere = root.appendingPathComponent("elsewhere")
        try fm.createDirectory(at: inbox, withIntermediateDirectories: true)
        try fm.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        let fromInbox = inbox.appendingPathComponent("photo.heic"); try Data("inbox".utf8).write(to: fromInbox)
        let dropped = elsewhere.appendingPathComponent("notes.txt"); try Data("drop".utf8).write(to: dropped)

        let moved = try OpenedFiles.adopt(fromInbox, root: opened, container: container)
        XCTAssertFalse(fm.fileExists(atPath: fromInbox.path), "iOS's own copy is moved, not left in Documents")
        XCTAssertEqual(moved.lastPathComponent, "photo.heic")
        XCTAssertEqual(try Data(contentsOf: moved), Data("inbox".utf8))
        let copied = try OpenedFiles.adopt(dropped, root: opened, container: container)
        XCTAssertTrue(fm.fileExists(atPath: dropped.path), "Another app's file is copied, never moved")
        XCTAssertEqual(try opened.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)

        OpenedFiles.discard([moved, dropped], root: opened)
        XCTAssertFalse(fm.fileExists(atPath: moved.deletingLastPathComponent().path))
        XCTAssertTrue(fm.fileExists(atPath: dropped.path), "A file outside the private folder is never deleted")
        XCTAssertTrue(fm.fileExists(atPath: copied.path))
        try Data("left".utf8).write(to: inbox.appendingPathComponent("left.txt"))
        OpenedFiles.clear(root: opened, inboxes: [inbox])
        XCTAssertFalse(fm.fileExists(atPath: opened.path))
        XCTAssertFalse(fm.fileExists(atPath: inbox.path))
        XCTAssertThrowsError(try OpenedFiles.adopt(elsewhere, root: opened, container: container), "Folders are refused")
    }
}
