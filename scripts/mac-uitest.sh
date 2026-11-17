#!/bin/bash
# Flux's Mac UI tests (FX-A-14/B-20; PLAN §4.11 shared flows, D-086, D-105), after Mac Control's harness:
#   build  a Debug build of Flux, copied as "Flux UITests.app" with the Debug bundle id com.sequoyah.flux.mac.uitest (D-142), ad-hoc signed
#          with mac/Flux/Flux-Debug.entitlements (sandboxed, no iCloud), plus the FluxMacUITests bundle;
#   test   runs the bundle against that copy without rebuilding (D-083), one app process reset in place.
# The copy's own bundle id and sandbox container mean -uiTesting -resetData never touch the installed Flux.
# A Mac UI test moves the pointer and brings windows forward: run it only under heavy.sh with --uses mac-ui.
#   ~/dev/SharedKit/tools/heavy.sh --uses mac-ui -- bash scripts/mac-uitest.sh [build|test|all]   (default all)
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
unset SDKROOT  # D-062
APP_ID=com.sequoyah.flux.mac.uitest  # the Debug id (scripts/mac-project.py); never the release id (D-143)
derived="${FLUX_MAC_UITEST_DERIVED:-/tmp/flux-heavy/macui}"
out_dir="$PWD/.test-output/mac-uitests"
app="$out_dir/Flux UITests.app"
mode="${1:-all}"
# The test bundle builds in its own derived data: package modules built for the app build are not reused (they came
# out "built for incompatible target" for the test bundle when the two shared a folder).
tests_derived="$derived-tests"
runner="$tests_derived/Build/Products/Debug/FluxMacUITests-Runner.app"
# D-134: whatever happens (failure, timeout, kill), quit the test-built copy and the test runner this run started, and
# nothing else: only processes whose executable lives in those bundles. The owner's installed Flux is never touched.
cleanup() {
    status=$?
    [ -n "${staging:-}" ] && rm -rf "$staging"
    pkill -f "$app/Contents/MacOS/" 2>/dev/null || true
    pkill -f "$runner/Contents/MacOS/" 2>/dev/null || true
    sleep 2
    if pgrep -f "$app/Contents/MacOS/|$runner/Contents/MacOS/" >/dev/null; then
        pkill -9 -f "$app/Contents/MacOS/" 2>/dev/null || true
        pkill -9 -f "$runner/Contents/MacOS/" 2>/dev/null || true
    fi
    if pgrep -fl "$app/Contents/MacOS/|$runner/Contents/MacOS/"; then echo "D-134: test-built processes still running" >&2; status=1
    else echo "D-134: no test-built Flux or runner left running"; fi
    exit "$status"
}
trap cleanup EXIT INT TERM
if [ "$mode" = build ] || [ "$mode" = all ]; then
    python3 scripts/mac-project.py
    xcodebuild -project mac/Flux.xcodeproj -scheme Flux -configuration Debug -derivedDataPath "$derived" \
        CODE_SIGNING_ALLOWED=NO -quiet build
    mkdir -p "$out_dir"
    staging="$(mktemp -d "$out_dir/.staging.XXXXXX")"
    stage="$staging/Flux UITests.app"
    ditto "$derived/Build/Products/Debug/Flux File Converter.app" "$stage"
    xattr -cr "$stage"
    codesign --force --sign - --entitlements mac/Flux/Flux-Debug.entitlements "$stage"
    codesign --verify --strict "$stage"
    rm -rf "$app"
    mv "$stage" "$app"
    [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist")" = "$APP_ID" ]
    xcodebuild build-for-testing -project mac/Flux.xcodeproj -scheme FluxMacUITests -destination 'platform=macOS,arch=arm64' \
        -derivedDataPath "$tests_derived" -quiet
fi
if [ "$mode" = test ] || [ "$mode" = all ]; then
    results="$out_dir/results-$(date -u +%Y%m%d-%H%M%S).xcresult"
    # Rerun only what failed (D-136): FLUX_MAC_UITEST_ONLY="testA testB" limits the run to those tests.
    only=()
    for name in ${FLUX_MAC_UITEST_ONLY:-}; do only+=("-only-testing:FluxMacUITests/FluxMacUITests/$name"); done
    FLUX_MAC_UITEST_APP="$app" TEST_RUNNER_FLUX_MAC_UITEST_APP="$app" \
    xcodebuild test-without-building -project mac/Flux.xcodeproj -scheme FluxMacUITests -destination 'platform=macOS,arch=arm64' \
        -derivedDataPath "$tests_derived" -parallel-testing-enabled NO -resultBundlePath "$results" -quiet ${only[@]+"${only[@]}"}
    echo "Mac UI tests passed; results in $results"
fi
