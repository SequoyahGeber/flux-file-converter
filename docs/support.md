# Flux support

Flux for TestFlight has Mac and iPhone clients for the private Unraid converter. You need an internet connection and an invitation from the workspace owner. Open Invitation in the app, paste the link, sign in and complete Cloudflare MFA. Links expire after 24 hours and can be claimed once.

Select files to upload them, choose Convert files, Compress files or ZIP & Unzip, then run the operation. Use Save as on a completed result to choose its filename and folder in the Mac save dialog. On iPhone, Save as starts a download; use the native Downloads screen to rename it, save to Files, or share it. Keep Flux open during transfers. On Mac, the native Downloads sidebar shows progress, cancellation and Show in Finder. Original files stay on your Mac.

Uploads are limited to 5 GB for eligible media and 1.9 GB for other files. Conversion jobs time out after 10 minutes and share one bounded server queue. Uploads/results expire after 30 minutes of inactivity. An unavailable format, codec, encrypted file or archive that exceeds safety limits may be rejected; arbitrary file types cannot be converted to every other type. All formats lists the actual supported routes.

If your session expires, reconnect and sign in again. If a download fails, save the result again before the server session expires. If a completed download cannot be saved in the selected folder, use Choose Save Location in the Mac sidebar. Delete my files removes server uploads and results from your session; it does not delete files already saved on your Mac.

On iPhone, open the Workspace menu for Sign Out. Authenticator MFA is supported; Cloudflare passkeys in the embedded browser need an additional website association and are not yet verified.

Support: sequoyahgeber@gmail.com. Public bug reports: [GitHub issues](https://github.com/SequoyahGeber/flux-file-converter/issues). Include the app version, macOS version, file format and error message. Do not attach private files, login credentials or invitation links to public issues.
