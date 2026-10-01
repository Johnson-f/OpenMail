// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "OpenMailKit",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "OpenMailKit", targets: ["OpenMailKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/groue/GRDB.swift", from: "7.0.0"),
    ],
    targets: [
        .target(
            name: "OpenMailKit",
            dependencies: [.product(name: "GRDB", package: "GRDB.swift")]
        ),
        .testTarget(
            name: "OpenMailKitTests",
            dependencies: ["OpenMailKit"]
        ),
    ]
)
