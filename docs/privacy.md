# Flux privacy policy

Updated October 3, 2026.

Flux is maintained by Sequoyah Geber. The TestFlight Mac and iPhone apps connect to the private converter at `fileconverter.sequoyahgeber.com`. The separate offline Electron app processes files locally. Each app's welcome screen identifies which service it uses.

## Files and conversion

The server client uploads only files you select or drop into the workspace. It sends their contents, names, sizes and conversion settings through Cloudflare to the owner's Unraid server. Files may contain documents, photos, video, audio or other user content. They are used for malware scanning, conversion, compression, archive creation/extraction and delivering results. They are not used for advertising, profiling or training an AI model.

Server uploads and results expire after 30 minutes of inactivity. You can remove your session's uploads and results sooner with Delete my files. Downloads are staged in the app's private cache. Failed or cancelled transfers are removed; completed results that could not be saved are retained for choosing another location until cleared or the next launch. Results you save to a chosen folder, Files or another app remain there until you manage them yourself. Flux does not automatically open or execute downloaded files.

## Accounts and access

Cloudflare Access handles login, MFA and connection security. The workspace receives the authenticated email and identity it needs to enforce access. The owner can see invited members' emails, join dates and invitation status, and can revoke access. Membership records remain while access is granted; pending invitations expire after 24 hours. The native app uses WebKit's app-specific website storage to retain login/session information. Sign out in the workspace to end the current login.

Cloudflare processes connection and security information, including IP addresses and browser/device information, under its [privacy policy](https://www.cloudflare.com/privacypolicy/). Flux includes no advertising or tracking SDK. Access records and your uploaded files are not shared with other invited users by the application.

## TestFlight

Apple separately collects TestFlight crash reports, usage information and feedback under its [TestFlight terms](https://www.apple.com/legal/internet-services/itunes/testflight/). Do not include private document contents, invitation tokens or login information in feedback or public bug reports.

## Questions and deletion

Contact the workspace owner to revoke your membership or ask about account records. For app support, contact sequoyahgeber@gmail.com or report a problem through the [Flux repository](https://github.com/SequoyahGeber/flux-file-converter/issues). Use private communication for sensitive details; GitHub issues are public.
