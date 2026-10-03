// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OfflineKit",
    platforms: [.macOS(.v14), .iOS("18.4")],
    products: [.library(name: "OfflineKit", targets: ["OfflineKit"])],
    dependencies: [
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.20"),
        .package(url: "https://github.com/jpsim/Yams.git", exact: "6.2.2")
    ],
    targets: [
        .binaryTarget(name: "FluxMedia", path: "FluxMedia.xcframework"),
        .target(name: "OfflineKit", dependencies: ["FluxMedia", "ZIPFoundation", "Yams"], resources: [.process("Resources")],
                linkerSettings: [.linkedLibrary("z"), .linkedLibrary("bz2"), .linkedLibrary("iconv")]),
        .testTarget(name: "OfflineKitTests", dependencies: ["OfflineKit"], resources: [.process("Resources")])
    ])
