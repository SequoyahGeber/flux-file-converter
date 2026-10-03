# Mac TestFlight preparation

The shipped local app uses ordinary Electron and discovers tools on the developer's Mac. It is **not a TestFlight build**. This directory stages the offline Mac version; it does not change the Unraid converter or publish anything.

## Current release blockers

The initial audit on October 3, 2026 found no Flux App Store Connect record or registered `com.sequoyah.flux.mac` identifier. The keychain has Apple Development and Developer ID Application identities, but no local Apple Distribution/Mac App Distribution and Mac Installer Distribution identities. None of the installed provisioning profiles belongs to Flux.

The conversion engines still need a portable, redistribution-reviewed bundle. Copying Homebrew executables or the existing Python virtual environment does not make them portable: their dylibs, Python standard library, codecs, plugins, OCR data, and other resources can point outside the app. Calibre and Blender must also carry their supporting resources. The conversion catalog must retain the same functional routes. Do not remove formats silently or enable host-tool discovery as a workaround.

## Build gate

Run `npm run testflight:check` to report missing requirements. Supply these variables privately when they are ready:

| Variable | Purpose |
| --- | --- |
| `FLUX_MAS_RESOURCES` | Portable engine resource directory containing `engines.json`, all listed engines, supporting data, and `THIRD_PARTY_NOTICES.md` |
| `FLUX_MAS_PROFILE` | Flux macOS provisioning profile matching the bundle ID, team, and signing mode |
| `FLUX_MAS_IDENTITY` | Exact Apple Development identity for sandbox testing; Apple Distribution/Mac App Distribution for TestFlight |
| `FLUX_MAS_INSTALLER_IDENTITY` | Mac Installer Distribution certificate for the TestFlight `.pkg` |
| `FLUX_MAS_BUILD` | Positive, increasing numeric build number for App Store Connect |
| `FLUX_MAS_PRIVACY_MANIFEST` | Reviewed `PrivacyInfo.xcprivacy` covering actual app/runtime API use; copied into `Contents/Resources` |
| `FLUX_MAS_TEAM` | Developer team; defaults to `8MLN9FH4F9` |
| `FLUX_MAS_BUNDLE_ID` | Registered Flux ID; defaults to `com.sequoyah.flux.mac` |

`engines.example.json` documents the relative executable paths. `engines.json` must be inside the resource directory. Symlinks must resolve inside that directory. The gate rejects absent engines and Mach-O library dependencies or RPATHs pointing to Homebrew, the developer's home, or another installed app. Relative loaders also need an actual clean-machine runtime test; passing static checks does not prove portability.

`npm run package:mas:dev` downloads Electron's **MAS** runtime, packages the app, signs nested binaries with inherited sandbox entitlements, and creates a development `.app`. This requires a development profile with the test Mac registered. `npm run package:mas` uses distribution signing and creates a signed `.pkg`. Both refuse to proceed if the gate fails; neither falls back to ad-hoc signing or uploads automatically.

The app entitlements allow user-selected read/write files and app-scoped bookmarks. They do not grant network, camera, microphone, arbitrary folder access, or execution of user-selected programs. Selected output folders are bookmarked for relaunch; input scopes are released when removed. Engine detection in MAS builds accepts only manifest-listed, bundled executables.

## Required acceptance before upload

1. Run `npm test`, `npm run test:desktop`, `npm run test:web`, and `npm run format:check`.
2. Launch the **development-signed MAS app** on a clean Apple Silicon Mac without Homebrew or developer caches. Confirm Apple's App Sandbox is active. Use real open/save panels, because mocked dialogs do not grant sandbox access.
3. Convert representative images, DOCX/PDF/spreadsheets, media, fonts, data tables, ebooks, subtitles, and models. Check lossless preservation, lossy quality, ZIP/extraction, resource limits, cancellation, failed-job cleanup, and source preservation.
4. Choose an external output folder, quit, relaunch, and verify access through its bookmark. Verify arbitrary unselected locations and network access are denied. Confirm all subprocesses inherit the sandbox. Release these checks as receipts against the exact build.
5. Review third-party redistribution requirements, embedded-engine signatures, required-reason API privacy manifests for Electron/native dependencies, app privacy answers, export compliance, beta description, contact details, support/privacy URLs, and screenshots. The offline code has no analytics or upload flow; dependency privacy claims still need a binary-level review.
6. Create the Flux bundle ID, App Store Connect **macOS** record, profiles, and signing identities. Validate the signed `.pkg` with Apple's Transporter and upload only when deployment is requested.
7. Treat upload, processing, export compliance, TestFlight availability, external Beta App Review, group assignment, and installed tester acceptance as separate milestones. Do not label an uploaded or processed build as available to friends without checking its actual status.

TestFlight screenshots and “What to Test” can use synthetic inputs from `tests/desktop.cjs`. The offline build requires no reviewer login. If the product becomes a client for the private Unraid service, reviewer access and an explicit upload/privacy flow must be designed before submission.

Primary references: [Electron MAS guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide), [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox/), [security-scoped file access](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox).

Privacy declarations must describe the exact bundled app and native dependencies. The build gate requires a reviewed manifest rather than guessing the required-reason categories for Electron, Python, or conversion tools. See Apple's [privacy manifest guidance](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk) and [required-reason API guidance](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).
