# Flux Local TestFlight

Mac and iPhone are on-device apps using one App Store Connect record and bundle ID. The separate server website is not embedded in either app. Previous 1.0.1 server-client betas are obsolete.

| Target              | Bundle ID               | Minimum OS | Artifact             |
| ------------------- | ----------------------- | ---------- | -------------------- |
| Mac, Flux Local.app | `com.sequoyah.flux.mac` | macOS 14   | Signed universal PKG |
| iPhone, Flux.app    | `com.sequoyah.flux.mac` | iOS 18.4   | Signed arm64 IPA     |

Both platforms use [the Flux app record](https://appstoreconnect.apple.com/apps/6818735397/testflight), a private internal owner group, and no public tester link. The original separate iPhone record is retained only as history and is no longer the release target.

## Build and checks

The shared `native/OfflineKit` Swift package pins ZIPFoundation 0.9.20 and Yams 6.2.2. The checked-in static XCFramework embeds FFmpeg 9.0.2 with networking, URL protocols, programs, external libraries, GPL and nonfree features disabled. `python3 scripts/build-local-media.py` reproduces it from checksum-pinned source; the C wrapper permits only explicitly opened file descriptors and denies secondary resource opens. Decoder probing uses one thread per track. FFmpeg only remuxes compatible encoded tracks; Apple frameworks perform supported local image/audio/video encoding.

Run `swift test --package-path native/OfflineKit` for real conversions, archive attacks, cancellation and styled DOCX output. The suite includes a synthetic H.264/AAC MP4 remux fixture; encoded packet hashes can also be compared with ffprobe. For iPhone simulator tests, run `xcodebuild -scheme OfflineKit -destination "platform=iOS Simulator,id=SIMULATOR_ID" CODE_SIGNING_ALLOWED=NO test` from the package directory. Also run `npm test`, `npm run test:mac` and `npm run format:check`; CI builds both native targets without signing secrets.

Generate with `python3 scripts/mac-project.py` and `python3 scripts/ios-project.py`. The native version is in `native/VERSION`. `python3 scripts/mac-release.py --build NUMBER` and `python3 scripts/ios-release.py --build NUMBER` create signed artifacts and receipts without uploading. `--development` is available for Mac sandbox tests. Private settings/profiles/certificates remain in `~/.appstoreconnect/flux`; scripts use the dedicated Flux keychain and stable Xcode without modifying global Xcode selection.

Verify signature, Mac sandbox and user-selected access with only the WebKit client entitlement (remote resources blocked), arm64 iPhone, universal Mac, privacy manifests and absence of the old server endpoint in each release. Validate/upload the exact hashed artifacts with Apple, verify processing is VALID, then assign the intended private group. Packaging, processing, tester assignment, installation, simulator acceptance and physical-iPhone acceptance remain separate evidence.

## Acceptance and disclosure

Use synthetic files for native pickers, conversion, naming/save/export, cancellation and background handling. Confirm the apps can convert with no login/server connection. The local catalog has fewer document/office/3D/ebook engines than the legacy Electron/server catalogs; never claim universal conversion or perfect Office layout fidelity.

Review `docs/privacy.md`, `docs/support.md`, the native format screen and App Store Connect metadata for consistency. The native app collects no user data. Required reasons cover private/user-selected file metadata, disk space checks and conversion timers. Open-source licenses ship in the package resource bundle. Keep TestFlight release private unless external testing is explicitly requested and Apple’s review/group requirements are satisfied.

For external beta preparation, follow [beta-review.md](beta-review.md). Release 1.0.3 includes fictional sample files using the real converter, an offline privacy/support screen and matching public pages. The beta-review CLI guards exact platform builds and metadata; review submission keeps public links and tester notifications separate.
