# Full local Mac build (personal use)

The native Swift/WKWebView app uses the same conversion adapters as the server, with private bundled tools. It opens no local HTTP listener, needs no account/server, and never falls back to Homebrew or separately installed converter apps. Native pickers authorize inputs; the bridge copies them into a private job directory before launching the sandbox-inheriting worker. Save/export uses the existing native picker and safe replacement flow. Calibre uses built-in MIME mappings instead of reading the system Apache configuration. Ebook PDF export passes through a Word intermediate and the bundled Office renderer, avoiding Chromium's unavailable global Mach service.

This owner's build targets Apple Silicon converters. The Swift UI remains universal; a full Intel converter bundle has not been built or verified. 3D is excluded by default at the owner's request. Catalog counts include engine aliases and vary with tool versions/platforms; they are not a guarantee that every codec/document variant converts perfectly.

## Build

On the configured development Mac, `python3 scripts/mac-engines.py` creates a private stage at `/private/tmp/flux-full-engine/ConversionEngine`. `FLUX_MAC_ENGINE_RESOURCES` overrides it. Dependencies include the configured Node runtime, complete Office/Calibre apps and Homebrew tool/library/data prefixes; their private manifest paths are relocated for installation. `--with-3d` opts into Blender; the normal personal build excludes it.

Run `python3 scripts/mac-prune-engines.py STAGE/ConversionEngine --architecture arm64` before signing. This removes static build archives, manuals, developer headers, package-installation tools, cached bytecode and redundant Intel slices. Runtime fonts, codec modules, Python dependencies and Calibre's headless PDF renderer remain. Notices are retained before pruning. Re-sign after any pruning; signed Calibre resources use extended attributes, which must survive copying and ZIP packaging.

Run `node scripts/native-desktop.mjs`, then `python3 scripts/mac-release.py --build NUMBER --development`. `--work-dir PATH` retains build intermediates. Development bundles are local owner artifacts, not public releases. Packaging refuses distribution while the engine manifest's licensing review is incomplete, and also requires complete converter architectures for both Intel and Apple Silicon.

The UI and Node worker retain hardened runtime and sandboxing. Node runs without JIT. Office's UNO bridge needs its own narrowly scoped JIT entitlement; all converter children inherit the app sandbox. The main app's entitlements are unchanged.

## Verification

`node tests/mac-bundled-engine.cjs STAGE/ConversionEngine` checks real representative image/compression, PowerPoint, spreadsheet, PDF/Word, ebook/PDF, font, Parquet, archive and video conversions with the private tool paths and minimal environment. A signed child cannot run directly from an unsandboxed shell: acceptance of the signed bundle must use a sandboxed native parent. The installed app's PPTX-to-PDF/save flow is checked separately with the owner's 31-slide lecture. These checks do not prove every format/codec or perfect Office layout fidelity.

## Distribution licensing is unresolved

This is a personal-use bundle. It has not been uploaded to Apple or distributed to testers. Copying third-party notices alone does not establish redistribution compliance, and running a component as a subprocess does not automatically settle whether it is a separate aggregate.

- Ghostscript and PyMuPDF/MuPDF use AGPL or commercial licensing. Artifex's requirements must be resolved for both redistribution and server use: https://artifex.com/licensing and https://pymupdf.io/licensing.
- The selected FFmpeg build enables GPL and version 3, including x264/x265. It is not the restricted LGPL media library used by the earlier native release: https://ffmpeg.org/legal.html.
- Calibre is GPLv3; Pandoc is GPLv2-or-later. Corresponding source, notices and distribution terms need review: https://manual.calibre-ebook.com/faq.html and https://github.com/jgm/pandoc/blob/main/COPYING.md.
- LibreOffice and all transitive libraries/fonts also require an exact-version notice/source/license inventory: https://www.libreoffice.org/licenses/.

Public distribution needs a deliberate licensing/source strategy and an Apple distribution compatibility review. No license purchase or relicensing of Flux is implied by this personal build.
