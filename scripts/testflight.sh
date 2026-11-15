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
if [ "$platform" = mac ] && [[ " $* " != *" --dry-run "* ]]; then
    python3 scripts/mac-release.py --build "$build"
fi
exec python3 -I "$SHAREDKIT/tools/testflight_upload.py" --config "Config/testflight-$platform.json" "$platform" "$build" "$@"
