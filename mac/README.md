# Flux Connect native Mac client

This target uses SwiftUI and WebKit to connect to the private Unraid converter. It adds native file selection, invitation entry, save dialogs, bounded download staging, download progress/cancellation, and Finder shortcuts. The native product is installed as `Flux Connect.app`, which avoids replacing the offline `Flux.app`. The separate Electron target continues to provide local conversion.

The client requires a network connection, an invitation and Cloudflare login/MFA. Selected files are uploaded to the server; the welcome screen, upload dialog, and in-app Privacy & Storage sheet disclose this. No conversion binaries, Node runtime, third-party native SDKs, JavaScript-to-native bridge, advertising SDKs or updater are packaged. Navigation and subresource requests are restricted to the workspace, the owner's Cloudflare Access host and Cloudflare's challenge frame. Downloads must be successful bounded responses from the workspace's result endpoint. Existing user files are replaced only after a complete download and successful staging on the destination volume.

## Build

Run `python3 scripts/mac-project.py` to generate the project and copy the shared icon. Open `mac/Flux.xcodeproj` in Xcode, or use `python3 scripts/mac-release.py --build 2026100301 --development` and then the same command without `--development` for an App Store distribution package. Release builds are universal for Apple Silicon and Intel, target macOS 14 or later, and contain no developer endpoint override. The release script uses the installed release Xcode without changing the global developer directory.

Private signing settings belong at `~/.appstoreconnect/flux/Signing.local.json`:

```json
{
  "team": "YOUR_TEAM_ID",
  "bundleId": "com.sequoyah.flux.mac",
  "development": {"identity": "CERTIFICATE_SHA1", "profile": "/private/path/Development.provisionprofile"},
  "distribution": {"identity": "CERTIFICATE_SHA1", "profile": "/private/path/Distribution.provisionprofile"},
  "installerIdentity": "INSTALLER_CERTIFICATE_SHA1"
}
```

Keep private keys and credentials out of the repository. The build validates the app/team, certificate/profile match, expiry, actual signed entitlements, universal architecture and absence of debug endpoints. It preserves an archive ZIP with symbols and a package receipt under `release/native`; neither command uploads or releases a build to testers.

## Validation

Run `npm run test:mac` for URL/invitation security and safe replacement tests. To exercise real NSOpenPanel/NSSavePanel and the Apple sandbox, run `node tests/mac-fixture.cjs`, build Debug with the Flux development profile, and launch that Debug binary with `--test-origin=http://127.0.0.1:43821`. The loopback fixture uses synthetic login/scanning dependencies and real installed conversion engines. Neither the fixture nor endpoint override is part of a Release archive.

App Store Connect validation, processing and TestFlight availability are separate from local sandbox acceptance. Before external Beta App Review, provide dedicated reviewer access and a walkthrough that works without the owner's credentials or MFA device. The production Cloudflare sign-in and guest MFA flow must be tested in WebKit; successful Chromium/browser testing does not prove this.

## Privacy review

`Flux/PrivacyInfo.xcprivacy` declares account email/identity and uploaded documents, photos/video and audio used for app functionality, linked to the signed-in account, without tracking. The native source does not read UserDefaults, file timestamps, disk capacity, boot time or active keyboard lists, and has no third-party SDK. Any new required-reason API use must be reviewed and declared. Apple's system frameworks are used for browsing, TLS, save panels and file replacement.

The client stages downloads in its own cache, limits occupied staging slots to two/5 GB/10 minutes, saves large results off the main UI thread, and keeps at most 50 session entries. Failed/cancelled transfers are removed; completed results that could not be saved are kept for choosing another location and removed on Clear finished downloads or the next launch. Saved user files are never cleaned by the app. Downloaded files are never launched automatically.
