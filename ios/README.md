# Flux for iPhone

This native SwiftUI/WebKit app connects to the private Unraid converter at `fileconverter.sequoyahgeber.com`. It requires an internet connection, an invitation, login and authenticator MFA. The welcome screen and privacy sheet explain uploads before connecting. It supports iOS 18.4 and later and shares the Mac client's URL/invitation restrictions and privacy manifest.

Open Invitation accepts one-use, 24-hour links for the exact Flux domain. Choose files uses iOS's Files picker, including files from enabled document providers; only user-selected files receive access. Directories are excluded and batches are limited to 30 files. The workspace provides the server's supported conversion, compression and ZIP routes.

Save as starts a bounded download. Downloads shows progress/cancellation and lets you rename a completed result while keeping its extension, save it to Files with the system export picker, or share it with a chosen app. Saved files are never cleaned by Flux. Export copies the result, then removes only Flux's private staging copy after a successful picker result. Failed/cancelled transfers are removed; other completed staging copies are cleared on request or the next launch. Two occupied slots, 5 GB per result and a 10-minute timeout bound staging. Downloads stop when the app enters the background; keep Flux open during transfers and retry from the workspace if interrupted. The app-owned download directory uses complete file protection.

There is no JavaScript-to-native message handler, bundled conversion engine, background execution entitlement, advertising or tracking SDK, camera/photos permission, or updater. Navigation, subresources and download redirects use the shared restrictive policy. TLS uses Apple's normal validation. Downloaded files are never automatically opened. Authenticator MFA is the prepared sign-in path; Cloudflare passkeys require an additional associated-domain or system-browser integration before support can be claimed.

## Build and release

Run `python3 scripts/ios-project.py`, then open `ios/Flux.xcodeproj`. The app icon is a separate opaque iOS rendition of the shared Flux artwork; the Mac Dock icon is unchanged. CI builds Mac and iPhone targets without signing credentials.

`python3 scripts/ios-release.py --build BUILD_NUMBER` archives and signs a device app with the private Flux signing settings and creates an IPA plus an archive ZIP with symbols under `release/native`. Add this section to `~/.appstoreconnect/flux/Signing.local.json` alongside the Mac signing configuration:

```json
{
  "ios": {
    "bundleId": "com.sequoyah.flux.ios",
    "identity": "APPLE_DISTRIBUTION_CERTIFICATE_SHA1",
    "profile": "/private/path/Flux-iOS-Distribution.mobileprovision"
  }
}
```

The release script checks team/app/certificate/profile alignment, expiry, iPhone App Store entitlement boundaries, the actual code signature, arm64 architecture, the privacy manifest, and exclusion of the Debug-only loopback endpoint. It packages the already signed single-app archive in a standard IPA payload; it never uploads or assigns testers. Keep signing keys and profiles out of Git.

The [iPhone App Store Connect record](https://appstoreconnect.apple.com/apps/6818745721/testflight) uses a private internal owner group with public links disabled. Apple validation/upload/processing, production WebKit login/MFA, actual Files picker/export acceptance and reviewer access are separate gates. A simulator/device build does not establish that a beta is available or reviewed. `npm run test:mac` covers the shared URL/invitation/filename policy; `npm run test:web` also checks conversion, custom result names, downloads and narrow mobile layout. The loopback fixture uses synthetic login/scanning dependencies, never production security.
