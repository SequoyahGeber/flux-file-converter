# Audit fixes — 6 October 2026

This records the corrections for the findings in [the 6 October audit](audit-2026-10-06.md), made on branch `audit-fixes-2026-10-06` and not committed. The original report and its failing-output evidence remain historical records.

**Scope of these results:** local source, build and test checks only. Nothing was deployed, signed, installed, released or submitted. The website changes take effect only once a new image is built, verified and promoted.

## Status of each finding

| ID | Correction | Regression evidence |
| --- | --- | --- |
| A01 Restricted Mac build | The bridge uses the full engine only when a bundled `ConversionEngine` with a catalog is present. Otherwise it restores the original OfflineKit formats, limits, notes and conversion call. `mac-release.py` builds the restricted app by default, and the full engine is opt-in (`--full-engine`) with the licensing and architecture gates unchanged. A restricted build that contains `ConversionEngine` is refused. CI now checks that the restricted bundle has OfflineKit and the UI, and no `ConversionEngine`. | CI-equivalent Mac Release and iPhone simulator builds succeed. The rebuilt restricted bundle contains OfflineKit and DesktopUI and no `ConversionEngine`. OfflineKit 28/28 and safe-save checks pass. |
| A02 External references | **Blender:** unpacked references must resolve inside the model's folder, textures must be image files, and linked libraries are rejected. OBJ export copies textures with relative paths, so no absolute paths are written. **Calibre:** HTML input uses `--max-levels 0`. **ImageMagick (desktop):** a bundled `policy.xml` blocks the SVG/MSVG/MVG/MSL/TEXT/URL coders and `@` paths; without it, ImageMagick routes stay disabled. **SVG:** rendered by sharp from memory, including SVG disguised under another extension. **FFmpeg:** HLS/concat/DASH playlists are rejected. **LibreOffice:** `BlockUntrustedRefererLinks` is on. | `tests/audit-2026-10-06.test.cjs` (Blender, Calibre, SVG/policy and playlist cases). All fail on the old code and pass now. Probe: `probes/electron-after.txt`. |
| A03 Slow uplinks | Each chunk is sent by XHR and fails only after 60 s without upload progress. Failed chunks retry with back-off from the server's confirmed offset, using the new owner-scoped `GET /api/uploads/:id`. | 20 MiB at 100 KiB/s: previously failed at 121 s, now completes in 206 s (`probes/slow-upload-after.txt`). Lost-response and dropped-connection cases are in `tests/upload-resilience-ui.cjs`. |
| A04 Older browsers | `AbortSignal.any` and `AbortSignal.timeout` fall back to linked controllers. | Uploads succeed with both APIs removed (`tests/upload-resilience-ui.cjs`, `probes/abortany.cjs`). |
| A05 Shared upload slots | The global chunk-stream cap is 8 (each session still has at most two uploads), and 429 responses carry `Retry-After: 2`. The browser waits and resumes instead of discarding the upload. | A third concurrent user's chunk is accepted (`probes/concurrent-upload.cjs`). With every stream held, the browser retries and completes (`tests/upload-resilience-ui.cjs`). Node test asserts `Retry-After` and owner-scoped offsets. |
| A06 exFAT output | `publish()` falls back to an exclusive copy on `ENOTSUP`/`EPERM`/`EXDEV`/`EMLINK`/`ENOSYS`, keeping unique names and never overwriting. | Conversion to a disposable exFAT image succeeds, including a numbered second copy. A unit test covers the fallback without overwriting. |
| A07 `%` names | Tools receive a pattern-free alias: a temp-folder symlink for a stage whose output folder contains `%`/`[`/`]`, and a sanitized symlink for such inputs, used for inspection, conversion and compression. FFmpeg single-image outputs use `-update 1`. | `scan%03d` → JXL/WebP into `Q3%done 100%` now produce the selected (red) image. The test fails on the old code. |
| A08 Archive → ZIP | The worker wraps a file in a ZIP only when its format has no repack route. Targets are deduplicated. Swift uses the catalog's multi-part extensions (`tar.gz`, `tar.bz2`, `tar.xz`). | `tar.gz` → ZIP through `scripts/mac-engine.cjs` contains the archive members (`probes/mac-engine-after.txt`). |
| A09 Quit/crash | The worker holds a parent stdin pipe and stops its tools on EOF (opt-in via `FLUX_PARENT_PIPE`, with a 5 s hard exit). The bridge terminates running workers on `willTerminate`. The Swift SIGKILL fallback waits 8 s so the worker can stop its tool process groups. | With an encoder running, closing the pipe stopped the worker in 0.9 s with no tools left. |
| A10 Inherited sandbox | **Mitigated, not fully resolved.** The A02 controls and LibreOffice link blocking apply here too. Docs and in-app text now describe the inherited network and file access accurately. | Moving the worker into a separately sandboxed XPC service (no network, no user-selected access) is still required before any distribution. It needs signed sandbox testing that was not possible here. |
| A11 Long media | The full-engine worker uses up to 8 threads and allows two hours per tool and job. Electron and the server keep their limits. A busy-server status line replaces the redundant "reload" banner during reconnects. | Builds and the reconnect suite pass. A real long encode in the signed app was not run. |
| A12 Names | Extensions are stripped case-insensitively, and names are normalized to NFC with combining marks allowed. | `Photo.JPG` → `Photo.png`; NFD `café` → `café.jpg` (unit test and probe). |
| A13 Persistence | History writes fsync before rename. A history-save failure no longer marks a published conversion as failed. Leftover `.flux-XXXXXX` stages are swept before each batch (single-instance app). | Desktop acceptance suite passes. |
| A14 Error text | The worker emits one tagged `FLUX-ERROR:` line. Swift shows only that, with fallbacks for signals or missing output. Python helper tracebacks are reduced to their final message. | Probe shows the tagged line. The Blender rejection shows its message rather than a traceback. |
| A15 Docs | The full build prepends an accurate support note (limits, separate processes, sandbox, 3D availability). The React engine description derives 3D from the catalog. `mac-full-engine.md`, the Mac README path and the website README are updated. | Source review. |
| A16 Operations | **Restart policy:** unlimited `on-failure` (no lifetime budget), chosen over `unless-stopped` so the daemon never auto-starts Flux before the boot script mounts its scratch disks. **Signatures:** `start-unraid.sh` verifies the cosign signature against this repository's workflow identity and runs the verified digest. **Pins:** cosign v3.1.3, gVisor 20260928.0 (checksum embedded) and cloudflared 2026.10.0 by digest. **Monitoring** guidance is in `deploy/SECURITY.md`. | `bash -n` on every deploy script. The deployment agent ran cosign against the live `:stable` digest (pass) and a wrong identity (fail), and mocked fresh/unchanged/changed/bad-signature start paths. Unraid itself was not run. |
| A17 Provenance | `mac-engines.py` downloads official Node v24.21.0 with pinned SHA-256s. `architectures` is the intersection across every Mach-O file in the stage. | Tarballs verified, a tampered tarball rejected; the installed stage computes `['arm64']`, so the distribution gate correctly fails. |
| A18 Accessibility | iPhone: the quality slider has a label and value, the decorative icon is hidden from VoiceOver, and status/error changes are announced. Mac: the minimum window is 900×560. | iPhone build succeeds. The desktop UI at 900×560 has no horizontal clipping (vertical scroll). VoiceOver was not run. |
| A19 CI | A new macOS job installs the engines and runs `npm run native`, `npm test` (including `audit-2026-10-06.test.cjs`) and `npm run test:desktop`. The container build depends on it. `test:web` includes the upload resilience test. | YAML parses. The CI run itself has not been executed. |

## Verification

| Check | Result |
| --- | --- |
| `npm test` | 66 passed (57 existing + 9 new); the 8 new behavioural tests fail against the pre-fix code |
| `npm run test:web` | Passed, including the new `upload-resilience-ui.cjs` |
| `npm run test:desktop` | Passed |
| `npm run test:mac`, OfflineKit `swift test` | Passed; 28 tests |
| Mac Release and iPhone simulator Release builds (unsigned) | Succeeded |
| `npm run format:check`, `git diff --check`, `npm audit --omit=dev` | Clean; 0 vulnerabilities |

## Still open or unverified

- **A10:** the converter runs with the app's full sandbox until the XPC service split is done.
- **Website:** not deployed. Rebuild the image and confirm the CI macOS job passes, then promote, using `start-unraid.sh` for the verified update.
- **Not exercised:**
  - Real old Safari; uploads were tested in Chromium with the APIs removed.
  - Unraid restart and boot behaviour.
  - The signed full-engine app's quit and long-encode behaviour.
  - LibreOffice link blocking (LibreOffice is not installed locally).
  - VoiceOver.
