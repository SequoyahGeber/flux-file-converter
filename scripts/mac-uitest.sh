#!/bin/bash
# Flux's Mac UI tests (FX-A-14/B-20; PLAN §4.11 shared flows, D-086, D-105), after Mac Control's harness:
#   build  a Debug build of Flux, copied as "Flux UITests.app" with bundle id com.sequoyah.flux.uitests, ad-hoc signed
#          with Config/uitests-mac.entitlements (sandboxed, no iCloud), plus the FluxMacUITests bundle;
#   test   runs the bundle against that copy without rebuilding (D-083), one app process reset in place.
# The copy's own bundle id and sandbox container mean -uiTesting -resetData never touch the installed Flux.
# A Mac UI test moves the pointer and brings windows forward: run it only under heavy.sh with --uses mac-ui.
#   ~/dev/SharedKit/tools/heavy.sh --uses mac-ui -- bash scripts/mac-uitest.sh [build|test|all]   (default all)
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
unset SDKROOT  # D-062
APP_ID=com.sequoyah.flux.uitests
derived="${FLUX_MAC_UITEST_DERIVED:-/tmp/flux-heavy/macui}"
out_dir="$PWD/.test-output/mac-uitests"
app="$out_dir/Flux UITests.app"
mode="${1:-all}"
if [ "$mode" = build ] || [ "$mode" = all ]; then
    python3 scripts/mac-project.py
    xcodebuild -project mac/Flux.xcodeproj -scheme Flux -configuration Debug -derivedDataPath "$derived" \
        CODE_SIGNING_ALLOWED=NO -quiet build
    mkdir -p "$out_dir"
    staging="$(mktemp -d "$out_dir/.staging.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    stage="$staging/Flux UITests.app"
    ditto "$derived/Build/Products/Debug/Flux File Converter.app" "$stage"
    plutil -replace CFBundleIdentifier -string "$APP_ID" "$stage/Contents/Info.plist"
    xattr -cr "$stage"
    codesign --force --sign - --entitlements Config/uitests-mac.entitlements "$stage"
    codesign --verify --strict "$stage"
    rm -rf "$app"
    mv "$stage" "$app"
    [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist")" = "$APP_ID" ]
    xcodebuild build-for-testing -project mac/Flux.xcodeproj -scheme FluxMacUITests -destination 'platform=macOS' \
        -derivedDataPath "$derived" -quiet
fi
if [ "$mode" = test ] || [ "$mode" = all ]; then
    results="$out_dir/results-$(date -u +%Y%m%d-%H%M%S).xcresult"
    FLUX_MAC_UITEST_APP="$app" TEST_RUNNER_FLUX_MAC_UITEST_APP="$app" \
    xcodebuild test-without-building -project mac/Flux.xcodeproj -scheme FluxMacUITests -destination 'platform=macOS' \
        -derivedDataPath "$derived" -parallel-testing-enabled NO -resultBundlePath "$results" -quiet
    echo "Mac UI tests passed; results in $results"
fi
