# Flux for Mac, iPhone and Unraid

The browser version supports conversion, lossy/lossless compression, ZIP/extraction, editable download names and browser save-location selection. It is designed for invite-only access at `fileconverter.sequoyahgeber.com`. See [server security and deployment boundaries](deploy/SECURITY.md). The single Flux container is limited to two CPU cores and under 6 GB RAM, with a ten-minute conversion timeout and 5 GB media uploads (1.9 GB for other files because of antivirus limits).

[GitHub source and releases](https://github.com/SequoyahGeber/flux-file-converter). The Unraid template in `deploy/templates/my-flux.xml` pulls the public GHCR `flux-api:stable` image for Docker-tab updates; `compose.yaml` has equivalent settings. Production requires gVisor, Cloudflare Access and bounded scratch volumes prepared by `deploy/prepare-unraid.sh`. Do not replace them with server shares or remove isolation/resource limits.

For Unraid installation, save `FLUX_OWNER_EMAIL`, the Access issuer/audience, a random worker secret, and the dedicated tunnel token in root-only `/mnt/cache/appdata/flux-deployment/config.env`. Copy this repository into that directory's `source` folder. Run `prepare-unraid.sh`, `install-templates.sh`, and `install-boot-unraid.sh` from `source/deploy`, pull `ghcr.io/sequoyahgeber/flux-api:stable`, then run `start-unraid.sh`. Configure the dedicated tunnel route to `http://flux-api:8080`; the container resolves that name to its private loopback. Flux owns the `10.77.2.0/24` Docker network; that subnet must be free. Preserve the boot script and dedicated scratch volumes when updating.

In Unraid's Docker tab, use **Check for Updates**, then **Update** on **flux**. One image contains the web app, conversion engines, ClamAV and the official Cloudflare tunnel binary. Download your results first; temporary uploads/results are purged on restart. The template retains the gVisor runtime, resource limits and privilege-dropping startup. Every running service has a separate non-root UID and zero capabilities; root and four narrow capabilities are used only during trusted startup to prepare private directories and drop privileges.

The owner can use **Invite people → Create invite link** to generate a one-use link expiring after 24 hours. The first signed-in account to claim it becomes a member. Members can be revoked from the same screen; pending links can also be revoked. Links are stored only as hashes. Membership persists across container updates in the private API scratch volume, while conversion uploads/results remain temporary. Share links privately. First-time guests enroll an authenticator at the team's Cloudflare `/AddMfaDevice` page before entering Flux.

Invitation mode requires the Flux Access application to allow authenticated identities with MFA, while Flux independently enforces its owner/member allowlist on every data request. The App Launcher must permit email-authenticated enrollment without requiring an existing MFA device. Other Cloudflare applications retain their own policies. No Cloudflare account administration token is stored in the converter. Keep the original owner-only Cloudflare policy until the invitation-enabled image and owner configuration have been verified.

The browser lets you edit the output filename before **Save as**. Chrome/Edge can stream directly into a chosen local file. In Safari, set **Settings → General → File download location → Ask for each download** to choose the destination each time.

Flux converts files locally, compresses supported content, creates ZIPs from files and folders, and extracts archives. The installed app is `/Applications/Flux.app`; a rebuildable copy lives in `release/Flux.app`. Results default to `~/Downloads/Flux`; choose another destination in the app.

The full input-to-output reference is in `reference/Conversion matrix.html` (searchable) and `reference/Conversion matrix.csv` (all rows). Run `npm run formats` to regenerate it from the installed engines.

## What works

- Images: JPG, PNG, WebP, AVIF, HEIC, GIF, TIFF, SVG, icons, PSD, camera RAW, scientific formats, and the additional decoders discovered from ImageMagick.
- Media: formats discovered from FFmpeg, with common video/audio output formats, audio extraction, still frames, and animated GIFs.
- Documents: LibreOffice and Pandoc imports, including Word, Pages, spreadsheets, Numbers, presentations, Keynote, legacy Office files, diagrams, and publishing documents where the installed importer supports that file version.
- PDF: every page to PNG/JPG (multipage outputs become a ZIP), extracted text/HTML/Markdown, reconstructed DOCX, and local English OCR for scanned text pages.
- Ebooks: unencrypted EPUB, MOBI, AZW3, and Calibre-compatible ebooks.
- Fonts: TTF/OTF outlines packaged as WOFF/WOFF2, and web fonts restored to their original outline container. Collections export their first font.
- 3D: Blender, OBJ, STL, PLY, FBX, GLTF/GLB, USD, and Alembic inputs. Models with companion output assets become a ZIP.
- Data: JSON, YAML, XML, CSV/TSV, Parquet, Feather, NDJSON, and read-only SQLite exports.
- Subtitles: SRT, VTT, ASS, SSA, and other FFmpeg-compatible timed text.
- Archives: ZIP, TAR, GZIP, BZIP2, XZ, 7Z, and RAR extraction; ZIP/TAR/7Z repacking.

The catalog is generated from installed engine capabilities and includes aliases; its count is not a claim that every file with an extension can decode successfully. Unknown extensions are checked by content. Arbitrary ordinary files can be packaged into ZIPs, even when their contents have no meaningful conversion.

No app can convert every proprietary, encrypted, corrupt, or undocumented file into every other type. Valid output choices depend on file contents, codecs, installed engines, and format compatibility. RAW data without dimensions, encrypted ebooks, and unsupported proprietary projects need their native software or additional information. Flux reports conversion errors rather than merely renaming a file.

## Compression

- **Lossless:** OxiPNG preserves PNG pixels/metadata; JPEGtran preserves JPEG coefficients; QPDF recompresses PDF streams; WebP can preserve decoded pixels. ZIP preserves the original file bytes. Optional FFV1/MKV preserves decoded video frames and copies audio; it often increases size.
- **Smaller file:** WebP image encoding, MP4 video encoding, AAC audio encoding, and Ghostscript PDF downsampling. The quality and maximum-width options control output size.
- Same-format compression that produces a larger file keeps a copy of the original. The app shows the actual resulting size and savings; no reduction is guaranteed for an already compressed file.

Image conversion exports the first page/frame of multiframe input. JPG fills transparency with white. Raster-to-SVG embeds an image; it does not trace vector paths. CSV exports the first worksheet and loses workbook layout. 3D mesh exports may omit materials/animation. PDF-to-DOCX is a best-effort reconstruction. PDF rewriting invalidates digital signatures; lossy PDF processing may change forms and annotations. OCR can misread text.

Archives reject traversal paths, links, duplicate file paths, and special files. Creation/extraction is limited to 2 GB of expanded data and 25,000 entries. Each extraction gets a fresh folder. Output names are unique, and source files are preserved. Batches can be cancelled.

## Development and rebuilding

```sh
npm ci
npm run native
npm start
```

For another Apple Silicon Mac, `scripts/setup.sh` installs the local engines with Homebrew and the Python libraries, then builds the frontend. It also installs Calibre, LibreOffice, and Blender when missing. Run `npm run package` to create a local ad-hoc-signed `release/Flux.app`. The current build bundles its Office engine and Python libraries; media/image/ebook/3D tools are discovered on the Mac. It is not notarized for public distribution.

```sh
npm test                 # Real-format and preservation checks
npm run test:desktop     # End-to-end Electron UI checks with synthetic files
npm run package          # Build the Mac .app
```

The renderer is sandboxed, with Node integration off and an isolated preload bridge. Only narrow operations are exposed. Engine invocations use argument arrays, without a shell. Files are processed locally; output history is kept in the app's local application-support directory. Clear history removes records, not output files.

Desktop assets use a restricted `app://` origin with a content security policy. The bridge checks the sending frame; dropped files must be native selected files, and removing queue items releases their inspection records. Progress updates carry small job summaries. Conversion subprocesses receive an explicit environment without application credentials, have bounded output buffers and time limits, and cancellation terminates their local process groups. FFmpeg accepts local file/pipe protocols, LibreOffice macros are disabled, and image/media processing uses bounded thread counts. The local archive excludes development dependencies, browser/server-only packages, Python test fixtures and bytecode caches.

## Mac and iPhone TestFlight preparation

The native SwiftUI/WebKit server client is documented in [mac/README.md](mac/README.md). It provides native file and save dialogs, invitation entry, bounded downloads and Finder shortcuts without bundling conversion engines. `python3 scripts/mac-release.py --build BUILD_NUMBER` creates an Apple-signed universal Mac package. The client uploads selected files to the private Unraid converter; this is disclosed before connecting and in the file picker and privacy sheet. App Store Connect validation, production WebKit login/MFA and reviewer access still need independent verification before TestFlight release.

The iPhone SwiftUI/WebKit client is documented in [ios/README.md](ios/README.md). It shares the Mac client's URL/invitation restrictions and privacy manifest, and adds Files selection, native downloads, filename changes, Save to Files and sharing. `python3 scripts/ios-release.py --build BUILD_NUMBER` creates an Apple-signed iPhone IPA. It requires iOS 18.4 or later.

The separate Electron app continues to convert locally. `npm run testflight:check` applies to that offline target; the MAS engine-bundling instructions are in [packaging/mas/README.md](packaging/mas/README.md). Its full offline engine bundle still needs portability and redistribution clearance before Apple distribution. The local ad-hoc ZIP is a developer build. None of the packaging commands uploads or releases a build to testers.

`npm run format:check` checks source formatting; `npm run test:web` covers browser saves and invite UI. The GitHub security job also checks process hardening, full streaming writes, desktop asset isolation, bookmark lifetime, and MAS signing/engine boundaries.

## Engine references

Supported formats are discovered from [ImageMagick](https://imagemagick.org/formats/), [FFmpeg](https://ffmpeg.org/ffmpeg.html), [Pandoc](https://pandoc.org/MANUAL.html), and the bundled LibreOffice registry. Compression uses [QPDF](https://qpdf.readthedocs.io/en/latest/cli.html) and [Ghostscript](https://ghostscript.com/blog/optimizing-pdfs.html). Additional routes use [Calibre](https://manual.calibre-ebook.com/generated/en/ebook-convert.html), [fontTools](https://fonttools.readthedocs.io/en/latest/ttLib/ttFont.html), and [Blender](https://docs.blender.org/api/main/bpy.ops.wm.html).
