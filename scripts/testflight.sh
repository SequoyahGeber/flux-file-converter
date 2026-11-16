#!/bin/bash
# SHARED-EXPERIENCE: engineering | standard: PROJECT_STANDARDS.md §Engineering | local implementation; changes must be mirrored in every app listed there
# make testflight: SharedKit's tools/testflight_upload.py with Flux's configs. The Mac app ships as an installer
# package that scripts/mac-release.py builds and checks first; the iPhone app is archived by the shared tool.
set -euo pipefail
cd "$(dirname "$0")/.."
platform=${1:?ios or mac}
build=${2:?YYYYMMDDNN}
shift 2
SHAREDKIT=${SHAREDKIT_HOME:-$HOME/dev/SharedKit}
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
unset SDKROOT  # D-062
# The Mac package name carries the version; stop early if the config was not updated with native/VERSION (FX-A-13).
version=$(tr -d '[:space:]' < native/VERSION)
if [ "$platform" = mac ] && ! grep -q "Flux-Local-$version-{build}.pkg" Config/testflight-mac.json; then
    echo "Config/testflight-mac.json does not name the $version package from native/VERSION; update its package path." >&2
    exit 1
fi
if [ "$platform" = mac ] && [[ " $* " != *" --dry-run "* ]]; then
    python3 scripts/mac-release.py --build "$build"
fi
exec python3 -I "$SHAREDKIT/tools/testflight_upload.py" --config "Config/testflight-$platform.json" "$platform" "$build" "$@"
