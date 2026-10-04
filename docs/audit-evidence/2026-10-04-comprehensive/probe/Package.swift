// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "AuditProbe", platforms: [.macOS(.v14)], dependencies: [.package(path: "../../../../native/OfflineKit")], targets: [.executableTarget(name: "AuditProbe", dependencies: [.product(name: "OfflineKit", package: "OfflineKit")])])
