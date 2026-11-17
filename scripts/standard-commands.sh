#!/bin/bash
# SHARED-EXPERIENCE: engineering | standard: PROJECT_STANDARDS.md §Engineering | local implementation; changes must be mirrored in every app listed there
# The heavy parts of Flux's standard commands (Makefile); run under SharedKit's tools/heavy.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
SHAREDKIT=${SHAREDKIT_HOME:-$HOME/dev/SharedKit}
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
unset SDKROOT  # D-062
case "${1:?build, test or ui-test}" in
build)
    python3 scripts/ios-project.py
    python3 scripts/mac-project.py
    xcodebuild -project ios/Flux.xcodeproj -scheme Flux -configuration Debug -sdk iphonesimulator \
        -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/flux-build/ios CODE_SIGNING_ALLOWED=NO build
    xcodebuild -project mac/Flux.xcodeproj -scheme Flux -configuration Debug -derivedDataPath /tmp/flux-build/mac \
        CODE_SIGNING_ALLOWED=NO build
    ;;
test)
    swift test --package-path native/OfflineKit --scratch-path "${TMPDIR:-/tmp}/flux-offlinekit-check"
    ;;
ui-test)
    device=$(python3 -I "$SHAREDKIT/tools/simulators.py" udid "${2:-Shared-iPhone}")
    # D-134: whatever happens, quit the app and the test runner on the simulator, and Simulator.app if this run opened it.
    simulator_was_open=$(pgrep -x Simulator >/dev/null && echo yes || echo no)
    cleanup() {
        status=$?
        xcrun simctl terminate "$device" com.sequoyah.flux.mac 2>/dev/null || true
        xcrun simctl terminate "$device" com.sequoyah.flux.reviewtests.xctrunner 2>/dev/null || true
        if [ "$simulator_was_open" = no ] && pgrep -x Simulator >/dev/null; then osascript -e 'quit app "Simulator"' || true; fi
        exit "$status"
    }
    trap cleanup EXIT INT TERM
    python3 scripts/ios-project.py
    # Build once, then test without building (D-083).
    xcodebuild -project ios/Flux.xcodeproj -scheme Flux -destination "id=$device" -derivedDataPath /tmp/flux-ui \
        CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- PROVISIONING_PROFILE_SPECIFIER= build-for-testing
    xcodebuild -project ios/Flux.xcodeproj -scheme Flux -destination "id=$device" -derivedDataPath /tmp/flux-ui \
        -parallel-testing-enabled NO test-without-building
    ;;
*) echo "unknown command: $1" >&2; exit 2 ;;
esac
