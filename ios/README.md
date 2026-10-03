# Flux Local for iPhone

Native SwiftUI app for iOS 18.4+, with entirely on-phone conversion using Apple frameworks and bundled static libraries. It shares `native/OfflineKit` and `native/App` with Mac. No files are sent to Unraid and no login, invitation or MFA is needed. Files can come from the system picker’s document providers; providers may download selected cloud files themselves.

Choose files, select a supported output, name it, convert locally, then Save to… with Files. Multiple files can be zipped; ZIP extraction exports a folder. Results are not automatically opened. Keep Flux foreground while converting; backgrounding cancels active work. Original and saved files are never cleaned by the app.

Generate with `python3 scripts/ios-project.py`; build/sign with `python3 scripts/ios-release.py --build NUMBER`. Private settings are outside Git. The iPhone and Mac targets share `com.sequoyah.flux.mac` and [one TestFlight app record](https://appstoreconnect.apple.com/apps/6818735397/testflight). The older separate iPhone record is historical.

See [release workflow](../docs/testflight.md), [actual format limits](../docs/support.md) and [privacy](../docs/privacy.md). Simulator builds/tests and Apple processing do not establish physical-iPhone acceptance. The source contains no runtime server endpoint or developer upload override.
