#!/bin/bash
# Native builds that used to run in a GitHub workflow (removed: no GitHub workflows). They need the private
# SharedKit package, so they run on this Mac only. `npm run check:native` runs this through
# SharedKit's tools/heavy.sh, the shared heavy-work lock (PLAN.md §4.11).
set -euo pipefail
cd "$(dirname "$0")/.."
# Same Xcode as the release scripts and the other apps, whatever xcode-select points at.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
# Build products go outside the repo: Finder and file-provider metadata on the checkout
# make codesign reject resource bundles built inside native/OfflineKit/.build.
swift test --package-path native/OfflineKit --scratch-path "${TMPDIR:-/tmp}/flux-offlinekit-check"
python3 scripts/mac-project.py
xcodebuild -project mac/Flux.xcodeproj -scheme Flux -configuration Release -derivedDataPath /tmp/flux-native-check CODE_SIGNING_ALLOWED=NO build
resources="/tmp/flux-native-check/Build/Products/Release/Flux File Converter.app/Contents/Resources"
test -d "$resources/OfflineKit_OfflineKit.bundle"
test -f "$resources/DesktopUI/index.html"
# The full converter bundle is personal-use only and is added by mac-release.py --full-engine.
test ! -e "$resources/ConversionEngine"
python3 scripts/ios-project.py
xcodebuild -project ios/Flux.xcodeproj -scheme Flux -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/flux-ios-check CODE_SIGNING_ALLOWED=NO build
echo "Native check passed."
