# Flux support

Flux Local for Mac and iPhone works entirely on the device. No Unraid connection, invitation, login or MFA is required. The website is a separate server converter with Cloudflare login and invitations.

Choose one file, select an output format and set a name. Convert locally, then use Save to… to choose a destination with the Mac save dialog or iPhone Files export picker. You can edit the name after conversion before saving. Select several regular files to create a ZIP. Choose Extract ZIP to folder to unzip. Originals stay untouched; an explicitly confirmed Mac save can replace an existing destination atomically.

The local format screen describes actual support. DOCX PDF/HTML preserves supported fonts, emphasis, colors, basic tables and embedded images, with local pagination. Complex unsupported structures report an error. TXT/MD extraction removes formatting and is labeled separately. ODT/EPUB/HTML currently support text extraction only. Codec/container compatibility is required for lossless media remux. Not every file type can be converted into every other type.

Local limits: 5 GB per media file and in total, 512 MB other files, 16 MB text, 24 megapixel images, 200 input PDF pages, one job at a time and a 10-minute cooperative deadline. ZIP extraction is limited to 2,000 entries, 1 GB expanded and 200× expansion, with CRC checks; links and unsafe/duplicate paths are rejected. A cooperative deadline cannot interrupt every Apple framework operation immediately. Keep Flux open while converting. Backgrounding cancels active work.

Use Clear to delete Flux’s temporary files. Choosing new files or restarting also clears its previous working results. Saved files and originals are never included in cleanup. Device storage is needed for a working copy and output; lossless formats can be larger than the input.

The separate website keeps its existing 5 GB eligible media / 1.9 GB other upload limits, 10-minute jobs, server queue and 30-minute inactivity expiry. Native conversion does not contact it.

Support: sequoyahgeber@gmail.com. [Public bug reports](https://github.com/SequoyahGeber/flux-file-converter/issues) should include the app/build, OS, input/output formats and error. Use synthetic files; never post private documents or login details.
