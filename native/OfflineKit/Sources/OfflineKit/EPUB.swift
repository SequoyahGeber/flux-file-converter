import Foundation
import ZIPFoundation

enum EPUB {
    private static func local(_ node: XMLNode) -> String { String(node.name.split(separator: ":").last ?? "") }
    private static func children(_ node: XMLNode, _ name: String) -> [XMLNode] { node.children.filter { local($0) == name } }
    // References are relative to the OPF; ../ may stay within the ZIP.
    static func resolve(_ reference: String, base: String) throws -> String {
        guard let decoded = reference.removingPercentEncoding, !decoded.isEmpty,
              !decoded.hasPrefix("/"), !decoded.contains(":"), !decoded.contains("\\"),
              !decoded.contains("?"), !decoded.contains("#") else { throw LocalError.invalid("EPUB contains an unsafe content reference.") }
        var parts = base.isEmpty ? [] : base.split(separator: "/").map(String.init)
        for part in decoded.split(separator: "/", omittingEmptySubsequences: false) {
            if part == "." { continue }
            if part == ".." {
                guard !parts.isEmpty else { throw LocalError.invalid("EPUB content reference escapes the archive.") }
                parts.removeLast()
            } else { parts.append(String(part)) }
        }
        return try Archives.path(parts.joined(separator: "/"))
    }
    static func text(_ archive: Archive, control: JobControl) throws -> String {
        let container = try XMLTree.parse(Archives.read("META-INF/container.xml", archive: archive, control: control), control: control)
        guard local(container) == "container", let roots = children(container, "rootfiles").first,
              let root = children(roots, "rootfile").first(where: { $0.attributes["media-type"] == "application/oebps-package+xml" }),
              let rootPath = root.attributes["full-path"] else { throw LocalError.invalid("EPUB has no valid package rootfile.") }
        let packagePath = try resolve(rootPath, base: "")
        let package = try XMLTree.parse(Archives.read(packagePath, archive: archive, control: control), control: control)
        guard local(package) == "package", let manifest = children(package, "manifest").first,
              let spine = children(package, "spine").first else { throw LocalError.invalid("EPUB is missing its manifest or reading order.") }
        var items: [String: XMLNode] = [:]
        for item in children(manifest, "item") {
            guard let id = item.attributes["id"], !id.isEmpty, items[id] == nil else { throw LocalError.invalid("EPUB manifest identifiers must be unique.") }
            items[id] = item
        }
        let base = packagePath.split(separator: "/").dropLast().joined(separator: "/")
        var text = "", count = 0
        for reference in children(spine, "itemref") {
            try control.check()
            guard let id = reference.attributes["idref"], let item = items[id], let href = item.attributes["href"] else { throw LocalError.invalid("EPUB reading order references missing content.") }
            let path = try resolve(href, base: base)
            guard archive[path]?.type == .file else { throw LocalError.invalid("EPUB chapter is missing.") }
            if reference.attributes["linear"] == "no" || item.attributes["properties"]?.split(whereSeparator: { $0.isWhitespace }).contains("nav") == true { continue }
            guard ["application/xhtml+xml", "text/html"].contains(item.attributes["media-type"] ?? "") else { throw LocalError.invalid("EPUB reading order contains an unsupported chapter type.") }
            let data = try Archives.read(path, archive: archive, control: control)
            guard let html = String(data: data, encoding: .utf8) else { throw LocalError.invalid("EPUB chapter is not UTF-8.") }
            text += try Documents.htmlText(html) + "\n\n"; count += 1
            guard text.utf8.count <= LocalPolicy.textLimit else { throw LocalError.invalid("EPUB text exceeds 16 MB.") }
        }
        guard count > 0 else { throw LocalError.invalid("EPUB has no supported primary chapters.") }
        return text
    }
}
