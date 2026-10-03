# Flux for Mac

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

## Engine references

Supported formats are discovered from [ImageMagick](https://imagemagick.org/formats/), [FFmpeg](https://ffmpeg.org/ffmpeg.html), [Pandoc](https://pandoc.org/MANUAL.html), and the bundled LibreOffice registry. Compression uses [QPDF](https://qpdf.readthedocs.io/en/latest/cli.html) and [Ghostscript](https://ghostscript.com/blog/optimizing-pdfs.html). Additional routes use [Calibre](https://manual.calibre-ebook.com/generated/en/ebook-convert.html), [fontTools](https://fonttools.readthedocs.io/en/latest/ttLib/ttFont.html), and [Blender](https://docs.blender.org/api/main/bpy.ops.wm.html).
