import Foundation

/// Restoring the saved output folder (`output.folder`) at launch, kept apart from AppKit so
/// `tests/mac-policy.swift` can check it. Two rules:
/// - security-scoped access starts before the folder is looked at, because the sandbox hides it until then;
/// - restoring never removes the saved choice: only choosing another folder or "Forget folder" does.
enum OutputFolderRestore {
    static func restore(
        resolve: () -> URL?, startAccess: (URL) -> Bool, stopAccess: (URL) -> Void, exists: (URL) -> Bool
    ) -> (url: URL, scoped: Bool)? {
        guard let url = resolve() else { return nil }
        let scoped = startAccess(url)
        guard exists(url) else {
            if scoped { stopAccess(url) }
            return nil
        }
        return (url, scoped)
    }
}
