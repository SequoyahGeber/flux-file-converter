# Bundled local media library

FluxMedia wraps FFmpeg 9.0.2 for file-descriptor-only remuxing. Its networking,
protocol handlers, command-line programs, GPL/nonfree features and external
libraries are disabled. Small software decoders are included for timestamp/codec
probing; the wrapper does not expose a transcoding or script execution API.

Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz

SHA-256: `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`

FFmpeg is distributed under LGPL 2.1 or later. The complete applicable license is
bundled in OfflineKit’s resources alongside ZIPFoundation’s and Yams’ licenses.
The public Flux sources and build scripts provide the material needed to rebuild
and relink the app with a modified LGPL library. Modification for personal use
and reverse engineering to debug such library modifications are permitted.

Run `python3 scripts/build-local-media.py` with Xcode’s Apple SDKs to recreate the
static XCFramework (universal Mac, arm64 iOS and universal iOS simulator). Edit
the library source/build configuration as needed, regenerate the two Xcode
projects, and build with `CODE_SIGNING_ALLOWED=NO` or your own signing identity.
Installing your rebuilt iPhone app requires your own Apple development signing;
Flux’s private signing keys are neither required for rebuilding nor distributed.

The wrapper source is in `FluxMedia.c` and `FluxMedia.h`; the app’s conversion and
UI sources are in `../OfflineKit/Sources` and `../App`. No Homebrew binary or host
library is needed by the shipped app.
