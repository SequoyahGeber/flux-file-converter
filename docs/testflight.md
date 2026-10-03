# TestFlight release checklist

The native Mac and iPhone clients use the existing private Unraid converter. The offline Electron target is packaged separately. No engine bundle is included in either native client.

## Native targets

| Target | Bundle ID | Minimum OS | Package |
| --- | --- | --- | --- |
| Mac | `com.sequoyah.flux.mac` | macOS 14 | Apple-signed universal `.pkg` |
| iPhone | `com.sequoyah.flux.ios` | iOS 18.4 | Apple-signed arm64 `.ipa` |

Mac App Store Connect record: [Flux File Converter](https://appstoreconnect.apple.com/apps/6818735397/testflight). The iPhone record must be created separately with its registered bundle ID. The Apple API handles profiles, builds and TestFlight metadata; initial app-record creation needs App Store Connect's website.

## Build and verification

1. Run `npm test`, `npm run test:mac`, `npm run test:web`, `npm run format:check`, and `npm audit`.
2. Confirm the Mac and iPhone CI builds pass for the release commit. Signing credentials are never stored in CI.
3. Build with `python3 scripts/mac-release.py --build BUILD_NUMBER` and `python3 scripts/ios-release.py --build BUILD_NUMBER`. Preserve their receipts and archive ZIPs with symbols. Build numbers must increase after an upload.
4. Validate the exact signed package with Apple's upload tooling and the private App Store Connect API key. Packaging, local code-signature verification and Apple validation are distinct checks.
5. Upload privately and verify Apple processing finishes with a valid build. This is separate from assigning a group or making a beta installable.

Private signing configuration, profiles, keychain passwords, API keys and private keys belong outside the repository. The build scripts check profile/certificate/team/app alignment, expiration, release entitlements, architecture and exclusion of developer endpoints. Neither packaging command uploads or releases a build.

## Runtime and access acceptance

- Use synthetic files to verify login, authenticator MFA, invitation claim, conversion, compression and ZIP operations against the production server. The local fixture's synthetic login/scanner does not prove production authentication or scanning.
- Verify actual Mac selection and save dialogs, and iPhone Files selection, filename changes, export, sharing, cancellation and background interruption. Simulator compilation alone does not prove those flows.
- Cloudflare passkeys need a website association or system-browser authentication integration in native clients. Authenticator MFA is the prepared path; the owner's authenticator enrollment has been confirmed.
- Keep Cloudflare login/MFA and application invitation enforcement enabled. New native clients must not use a bundled Cloudflare service token or bypass the Access gateway.
- External Beta App Review needs dedicated reviewer access and a working walkthrough that does not require the owner's email, password or MFA device. Prepare that access before submitting for review. Do not release an external tester link until the build is approved and assigned to its intended group.

## Privacy and support

Review the shared `mac/Flux/PrivacyInfo.xcprivacy` whenever APIs, SDKs or uploaded data change. Reconcile App Store Connect's privacy answers with [privacy.md](privacy.md), the native privacy screens and actual server retention. [support.md](support.md) documents the two save flows and access requirements. Use synthetic files in screenshots and feedback; never publish invitation tokens or personal uploads.
