import Foundation

/// Files another app hands to Flux: "Open in Flux" from Files, Mail or Safari, and drag and drop (FX-B-16).
///
/// iOS gives Flux its own copy (in Documents/Inbox, or a tmp "-Inbox" folder) for an opened file, and a drop's file
/// may vanish once the drop ends. Flux moves or copies each one into a private folder in Caches, excluded from backup,
/// and deletes it on Clear, when another file is chosen, and at the next launch. So the privacy facts still hold: the
/// files people choose stay on the device and nothing of them is kept.
public enum OpenedFiles {
    public static var directory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("FluxOpenedFiles", isDirectory: true)
    }
    /// Where iOS puts copies of opened files: Documents/Inbox, and "<bundle id>-Inbox" folders in tmp.
    public static var inboxes: [URL] {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory
        let temporary = ((try? fm.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil)) ?? []).filter { $0.lastPathComponent.hasSuffix("-Inbox") }
        return [fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Inbox", isDirectory: true)] + temporary
    }

    /// Takes over `url`: a copy iOS already made for Flux (inside `container`, the app's own folder) is moved, anything
    /// else is copied. Returns the file's new place. Only regular files are accepted.
    public static func adopt(_ url: URL, root: URL = directory, container: URL = URL(fileURLWithPath: NSHomeDirectory())) throws -> URL {
        guard url.isFileURL else { throw LocalError.invalid("Flux can only open files.") }
        let fm = FileManager.default
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
            throw LocalError.invalid("Choose a regular file. Folders and links are not accepted.")
        }
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var excluded = root; try? excluded.setResourceValues(values)
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let destination = folder.appendingPathComponent(url.lastPathComponent)
        do {
            if isInside(url, container) { try fm.moveItem(at: url, to: destination) } else { try fm.copyItem(at: url, to: destination) }
        } catch { try? fm.removeItem(at: folder); throw error }
        return destination
    }
    /// Deletes the private copies among `urls`; other files (picked with the file picker) are never touched.
    public static func discard(_ urls: [URL], root: URL = directory) {
        for url in urls where isInside(url, root) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
    }
    /// At launch: every private copy, and anything iOS left in the inboxes.
    public static func clear(root: URL = directory, inboxes: [URL] = inboxes) {
        for folder in [root] + inboxes { try? FileManager.default.removeItem(at: folder) }
    }
    static func isInside(_ url: URL, _ folder: URL) -> Bool {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        let base = folder.standardizedFileURL.resolvingSymlinksInPath().path
        return path.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }
}
