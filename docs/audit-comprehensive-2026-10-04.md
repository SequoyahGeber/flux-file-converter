# Flux comprehensive application audit — 4 October 2026

**Subsequent implementation:** [the fix record](audit-fixes-2026-10-04.md) documents corrections and regression results for F01–F10. The assessment and evidence below describe the original audited commit.

## Executive assessment

**Hold a broad release until the silent-output defects are corrected or the affected routes explicitly reject unsupported input.** The strongest findings are successful conversions that change large numeric identifiers and successful native DOCX exports that remove equations. Ordinary small-file workflows work in the exercised paths, and the existing safety controls and regression suites are substantial. Their success does not establish conversion fidelity across the full advertised catalog or safety of the production deployment.

This independent audit examined commit `4e96283e37ddd377b55d1baefa4947f765c02356` on `main`. The tracked checkout was clean at entry. It follows, and does not overwrite, [the earlier audit](audit-2026-10-04.md). The earlier repairs were inspected and the relevant checks rerun; this report identifies remaining defects. No application code was changed, committed, pushed, deployed, installed into `/Applications`, or submitted to Apple.

Ten findings are prioritized below: **two high, seven medium, one low; all have a confirmed local reproduction.** Platform scope is explicit: native engine reproductions ran on Apple Silicon macOS; applicability to iPhone follows the shared implementation and still needs device-level regression testing. Shared Electron/server code was exercised locally; production Linux/Cloudflare/Unraid behavior was not exercised. No critical vulnerability was confirmed, and no security certification is claimed.

| Priority | ID | Finding | Severity | Affected implementation |
| --- | --- | --- | --- | --- |
| 1 | F01 | Numeric identifiers silently change during JSON conversion | High | Electron and shared server JavaScript data path |
| 2 | F02 | Native DOCX equations disappear from successful PDF/HTML outputs | High | Shared native Mac/iPhone engine |
| 3 | F03 | Advertised web batches stop at the per-minute job limit | Medium | Web client/API |
| 4 | F04 | Native ZIP creation produces archives its own extractor rejects | Medium | Shared native Mac/iPhone engine |
| 5 | F05 | EPUB extraction changes chapter order and includes navigation content | Medium | Shared native Mac/iPhone engine |
| 6 | F06 | Short WebVTT timestamps become an unusable SRT result | Medium | Shared native Mac/iPhone engine |
| 7 | F07 | Desktop format modal leaves keyboard focus behind the overlay | Medium | React UI used by Electron/native Mac |
| 8 | F08 | Desktop explanatory text has insufficient contrast | Medium | React UI used by Electron/native Mac |
| 9 | F09 | Advanced table routes bypass CSV schema validation | Medium | Electron/shared server Python adapter |
| 10 | F10 | Browser output notes stay stale after changing format | Low | Web client |

Recommended first actions: prevent silent corruption in F01/F02, add semantic output checks for the supplied fixtures, then align web batch submission and native ZIP creation with their existing protective limits. Address desktop accessibility before claiming keyboard/screen-reader readiness. Rebuild and validate exact release artifacts after corrections; source checks do not update an existing ZIP, TestFlight build, or server image.

## System and user-journey map

### Purpose, audience, and platforms

Flux serves people who need to convert, compress, archive, extract, and save files while retaining their originals. The README describes a locally installed full Electron converter, a private server-backed website, and narrower native on-device apps. This audit assumes ordinary user-selected documents and media may be untrusted, and that the owner/member audience can upload sensitive documents. There are no billing, subscription, financial calculation, or entitlement systems beyond server membership.

| Surface | Entry points and responsibilities | Engines/data boundaries | Support established by source |
| --- | --- | --- | --- |
| Electron Mac | React sidebar; native pickers/drop; queue, compression, archive, format catalog, history/settings; narrow isolated preload IPC | Main process selects files, detects tools, invokes subprocesses, publishes results into selected output folder; `state.json` stores output/bookmark/history | macOS; local packaging is an ad-hoc developer build; setup assumes Apple Silicon/Homebrew; complete engine availability is host-dependent |
| Native Mac | SwiftUI window embedding the same React UI in a private WebKit origin; opaque file IDs; native pick/save sheets | `DesktopBridge` → shared `OfflineKit`, Apple frameworks, ZIPFoundation, Yams, static FluxMedia; sandbox/user-selected scopes; no conversion server | macOS 14+, universal arm64/x86_64 build configuration |
| Native iPhone | SwiftUI `LocalView`/`LocalModel`; file importer, output/name/options, sample files, convert, Files export, clear, privacy/support | Same `OfflineKit`; private staged inputs/results; security-scoped provider files; backgrounding requests cancellation | iOS 18.4+; physical arm64 distribution; simulator tests use iOS 27.0 here |
| Website/API | Browser upload/inspect → output selection → jobs/poll → named download; delete files; owner invitations/revocation | Cloudflare Access signed JWT/host/origin validation plus persisted member allowlist; per-user private sessions; chunk uploads; scan → isolated worker → result scan → download | Browser UI; Chromium automation here. Chrome/Edge native-save branch; Safari fallback is documented, not exercised in Safari |
| Unraid/container | Tunnel → loopback API; API/worker/scanner/updater/tunnel/supervisor separate UIDs; bounded scratch volumes | Shared conversion adapters plus Linux compatibility/PDF helpers; ClamAV; seccomp parser child; outer gVisor; no published host port or user shares | Linux/Unraid deployment scripts; actual Docker/gVisor host unavailable in this audit |
| Build/release/support | npm/SwiftPM/Xcode; checked-in XCFramework; native signed release scripts; Electron/MAS scripts; container and Pages workflows | Node lockfile, exact Swift dependencies, pinned native media source checksum, private signing configuration outside Git; static support/privacy Pages | Builds, signing, upload, processing, installation and user availability are distinct milestones |

### Data flow and trust boundaries

```text
Electron:
user-selected originals → privileged selection/inspection → bounded tool invocation
  → staging inside output volume → exclusive publication → persistent local history

Native Mac/iPhone:
user-selected provider/file or bundled fictional sample → scoped streaming private copy
  → OfflineKit/Apple/static codecs → private session result → user-chosen save/export
  → clear/restart removes private working result; saved copy and original are separate

Website:
Cloudflare Access identity → Flux owner/member authorization → quota/reservation
  → 16 MiB upload chunks → malware scan → serial worker transport
  → seccomp conversion child → output validation/scan → owner-scoped download
  → delete/inactivity/restart removes conversion scratch

Membership:
owner creates hashed one-use invite → signed-in guest claims serialized transaction
  → atomic access.json update → member authorization on data requests
  → revoke member cancels known jobs and removes permission for subsequent requests
```

Sensitive assets are file bytes/names/metadata, results, identity emails and membership records, invite bearer tokens, worker/tunnel secrets, signing keys and distribution artifacts. Desktop parsers process untrusted bytes under the local user's or app sandbox's permissions; the native C wrapper restricts secondary resource opens. The server adds process, UID, filesystem and network isolation. Subprocess argument arrays avoid shell interpolation; that does not eliminate native parser vulnerabilities.

### Critical journey evidence

| Journey and expected completion | Normal path exercised | Boundary/failure and recovery evidence |
| --- | --- | --- |
| Select → convert → find/save a valid output | Electron UI batch PNG/JPEG, MP4/MKV, DOCX/PDF, multipage PDF/images; native shared-engine suite; browser upload/named download | Duplicate CSV headers rejected on JSON route; malformed/oversized inputs, strict UTF-8, scanned PDF text, original preservation and cancellation covered by existing tests. F01/F02/F05/F06 show remaining successful-but-wrong outputs |
| Compress while preserving the stated meaning | Electron UI lossless and lossy compression; codec/pixel/font preservation in engine suites | Same-format larger-result fallback and real-format tests ran. Native ZIP stored mode round trip works, compressed highly repetitive file fails extraction (F04) |
| Create ZIP → extract → recover original bytes | Electron UI ZIP/extraction; native byte/CRC, unsafe ZIP and 256 MiB stored-ZIP tests | Hostile paths/links/duplicate entries/encryption/expansion reject in tested cases. Native default compressed round trip failure newly reproduced; originals kept |
| Upload a batch → convert all → save results | Browser single-file normal path; isolated eight-file batch frontend/API probe | Six complete, seventh submission gets 429, remainder remains ready (F03). Worker/scanner are stubbed in this capacity probe; real server codecs not claimed |
| Cancel/retry/clear → consistent state | Existing native cancellation/setup cleanup and server late-result/deadline/streaming tests; browser delayed first-upload cancellation | Job/inspection late publication regressions passed; atomic save checks passed. Actual disk-full/provider-disconnect/process-crash recovery remains untested |
| Invite → first guest claims → revoke → access denied | Access unit/integration tests; browser invite test repeat; synchronized browser probe three runs | One unsynchronized browser run failed at revoke/reload; test race diagnosed separately below. Signed local cross-site redirect regression passed; live MFA policy not checked |
| Discover format and operate without a pointer | Electron format/search/settings/history UI; keyboard opening/Tab/Escape | Modal semantics/focus fails (F07); computed contrast fails (F08). VoiceOver and Switch Control were not used |
| Build and distribute exact verified artifact | Fresh unsigned native Mac and iPhone simulator Release builds | Current source build is not a signed distribution artifact. Legacy Electron package checks and simulator UI outcome are recorded below; live deployment/store state was not accessed |

## Coverage matrix

Statuses describe evidence depth, not a blanket pass. **Verified through runtime testing** applies only to the cases named; **partially verified** means substantive source review and some tests with remaining runtime gaps.

| Area | Applicability/risk | Methods and inspected boundaries | Coverage status and explicit gaps |
| --- | --- | --- | --- |
| A Product behavior/completeness | Applicable / high | All four surfaces, output catalog, real-format suites, sample routes, compression/archive, output/save/history, invite/revoke; added fidelity/batch probes | Partially verified. Primary Electron/browser flows and shared engine runtime-tested; full format/codec/import-version corpus, native Mac picker walkthrough and production deployment not verified |
| B Interface/usability | Applicable / medium | React/WebKit, SwiftUI and browser control/state source; Electron/browser acceptance screenshots; browser widths 1380/800/390; modal keyboard handling, notes/errors/loading | Partially verified. Desktop modal and browser mobile images visually inspected. Native Dynamic Type, 200% browser zoom, RTL, physical touch/keyboard and all long-name layouts not exhaustively exercised |
| C Accessibility/inclusive use | Applicable / medium | Semantics, names, keyboard focus/modal behavior, dynamic status source, CSS computed contrast; English UI and Japanese/Unicode tests | Partially verified. F07/F08 confirmed in Electron. Browser main progress lacks live-region semantics in probe. Manual VoiceOver, Switch Control, reduced motion and native large-text assessment remain gaps; no compliance claim |
| D Architecture/code quality | Applicable / high | IPC/preload, native bridge, shared engine dispatch, process runner, job/queue lifecycle, security scope ownership, duplicated helper/source synchronization, multiple data adapters | Inspected in source and partially verified through lifecycle tests. Practical policy drift demonstrated in F09. No architecture defect asserted merely because implementations differ |
| E Integrity/persistence | Applicable / high | Byte/pixel/packet/glyph/text preservation, CRC, safe publication/atomic saves, structured data, membership transactions, ephemeral history/deletion, malformed input and retry tests | Partially verified. F01/F02/F04/F05/F06/F09 confirmed. No service database migrations/synchronization system exists. Device power loss, cloud-provider concurrent edits and real disk-full persistence not verified |
| F Security/abuse | Applicable / high | JWT crypto/issuer/audience/expiry/host/origin, authorization/session isolation, invites, quotas, chunk framing, scanners, worker result/path validation, IPC/assets, process environment/group cancellation, archives/XML/YAML, deployment UID/seccomp/gVisor source | Partially verified. Synthetic auth/owner isolation/hostile-input/process tests passed. Actual ClamAV definitions/verdicts, Linux seccomp/gVisor/Unraid runtime, live MFA policy, parser exploit resistance and production secrets configuration not verified |
| G Privacy | Applicable / high | Policy/support, runtime endpoint references, entitlements/content blockers, native privacy manifest, logs, cleanup/retention and membership storage | Inspected in source and partially verified through cleanup/offline engine tests. No analytics SDK observed in inspected code. Cloudflare/Apple practices, live public-page parity, device backup behavior and forensic deletion not verified; no legal certification |
| H Performance/resources | Applicable / high | Streaming copy RSS/timing, native 50k-row table run and large stored ZIP; bounds on decoded images, output/text/archive/queue/storage; child/thread limits; advanced Python path | Partially verified. 512 MiB synthetic copy measured below. No device battery/thermal/memory-pressure/long-session soak; no real 5 GB media, production throughput, cold-cache/device comparison or container-cgroup measurement |
| I Reliability/lifecycle/recovery | Applicable / high | Cancel, late results, cooperative deadlines, scanner failure, incomplete request framing, shutdown/expiry, startup errors, history and atomic-save failures | Partially verified. Existing regression tests exercise several races and failures. Actual suspend/kill/relaunch while saving, low disk, damaged membership file restore and third-party provider availability remain gaps; offline native behavior is source-established and engine-tested |
| J Integrations/platform | Applicable / high | Native Apple APIs/file scopes/export sheets; Electron external tools; worker transport; Linux shims; tunnel/scanner; associations/menus/support URLs and release entitlements | Partially verified. Local engines used by npm suite. Intel built, not executed. iOS minimum version and actual providers not run. No webhooks, billing, push notifications, third-party business APIs or cross-device sync exist, so those subareas are not applicable |
| K Test quality | Applicable / high | 53 JS tests, 23 Swift tests, Electron/browser UI, native safe-save, Xcode builds, source hygiene/advisory scan; reviewed assertions/fixtures/CI and added independent output probes | Verified through runtime testing for listed suites, with a web UI flaky failure, blocked iPhone UI and artifact-provenance gap below. Existing happy-path/small-numeric fixtures miss these findings. No coverage percentage used as correctness evidence; no broad fuzz campaign or complete accessibility suite |
| L Build/deployment/operations | Applicable / high | npm lock, Swift exact pins/XCFramework build script, native release/profile checks, Electron/MAS gates, CI, Docker stages, boot/restore/scratch templates, health/restart/definitions/signature documentation | Inspected in source; fresh native builds verified. Docker unavailable. No signed new archive, Apple validation/upload, install acceptance, live service health/rollback or distribution signature enforcement checked. The existing Electron ZIP signature was verified locally. Docker/apt/tool tags are mutable, so a later container rebuild is not byte-reproducible from this source alone |
| M Documentation/maintainability | Applicable / medium | README, Mac/iPhone/MAS docs, earlier audit/issues, security/deployment, support/privacy/beta-review and CI consistency | Inspected in source. Native narrower support is disclosed; static claims are not live store/deployment evidence. README's rebuildable `release/Flux.app` was absent locally; only a legacy ZIP was available. Unsupported-format/fidelity guidance should reflect F02/F05/F06/F09 |

Authentication/account recovery/MFA are not applicable to the offline apps; they apply to the website through Cloudflare and Flux membership. Billing, money arithmetic, cross-device synchronization, webhooks and push-notification delivery are not implemented. Network degradation applies to the website, provider downloads and explicit support links; it is not a conversion-service dependency of the native apps.

## Prioritized findings

### F01 — Numeric identifiers silently change during JSON conversion

- **Category:** data integrity/product correctness. **Severity:** high. **Confidence:** confirmed.
- **Affected:** Electron JSON → CSV/YAML and the shared server JavaScript route. Native JSON → CSV preserved the same integer and decimal in the control test; do not apply this finding to all implementations.
- **Expected/actual:** numbers must retain their value or fail with a clear precision limitation. Input `[{"id":9007199254740993,"amount":0.1234567890123456789}]` successfully becomes CSV/YAML with `id: 9007199254740992` and shortened decimal `0.12345678901234568`.
- **Reproduction:** run the supplied `engine-probes.cjs` against `fixtures/precise.json`, or convert that JSON to CSV/YAML through the Electron data route and compare numeric token strings with the source.
- **Evidence:** [engine output](audit-evidence/2026-10-04-comprehensive/engine-probes.txt), [native control](audit-evidence/2026-10-04-comprehensive/native-probes.txt); `electron/engine.cjs:740–751, 783–825` parses into ordinary JavaScript numbers before serialization. The [JSON specification's numeric interoperability discussion](https://www.rfc-editor.org/rfc/rfc8259#section-6) explains the binary64 exact-integer boundary.
- **Root cause:** lossy numeric parsing precedes validation. `validData` checks shape/depth/reserved keys, not whether original numeric values can be represented exactly.
- **Impact/rating:** a successful, plausible file can contain a different record/account identifier. The user may not notice and recovery requires comparing original bytes. Originals remain available; no change to source files or server deployment was demonstrated. High severity reflects silent semantic corruption rather than magnitude of an observed monetary loss.
- **Correction:** preserve numeric lexemes with an exact integer/decimal representation through adapters, or reject unsupported precision before publication and explain how to represent identifiers as strings. Do not stringify all numbers silently or claim decimal exactness based only on `Number.isSafeInteger`.
- **Verification:** adjacent integers across the binary64 boundary remain distinct; high-precision decimals, exponents and negative numbers preserve value or explicitly reject. Reparse outputs with an independent exact-decimal parser. Check CSV/YAML/JSON and advanced Python routes; add these to engine and server checks.
- **Sequencing:** coordinate the shared policy with F09; avoid divergent precision behavior between table adapters and native clients.

### F02 — Native DOCX equations disappear from successful PDF/HTML outputs

- **Category:** document integrity/product behavior. **Severity:** high. **Confidence:** confirmed.
- **Affected:** native Mac/iPhone `OfflineKit` rich DOCX conversion. Runtime reproduced on macOS for both PDF and HTML; iPhone shares the code but the equation fixture was not exercised on a phone.
- **Expected/actual:** preserve supported content or explicitly reject unsupported content, as advertised by native support docs. A paragraph containing `Total: ` followed by an Office Math `m:oMath` equation `x + 2 = 3` converts successfully to a PDF/HTML containing only `Total:`.
- **Reproduction:** convert supplied `equation.docx` to HTML and PDF. Inspect HTML, then independently extract PDF text; the probe uses PyMuPDF and reports `'Total: \n'`.
- **Evidence:** [native output and independent PDF extraction](audit-evidence/2026-10-04-comprehensive/native-probes.txt); `RichDocuments.swift:95–98` has a finite unsupported-element denylist; `:152–160` emits only `w:r`/`w:t`, tab and break content. The supplied equation is inline in a normal paragraph and bypasses the rejection list.
- **Root cause:** unsupported content within supported paragraphs is silently skipped. The successful block list feeds both renderers.
- **Impact/rating:** omission changes substantive mathematical content while the user receives a success/result. This is more consequential than a styling/layout discrepancy. The test establishes content omission, not a downstream business or safety incident.
- **Correction:** immediately reject Office Math until it can be represented faithfully. Audit the surrounding paragraph/run grammar for other substantive unsupported constructs and prefer explicit supported-node validation over an incomplete blacklist. Keep TXT extraction explicitly disclosed if it also omits content.
- **Verification:** both PDF and HTML preserve the fixture's equation or reject without publishing a result; originals and temporary cleanup remain intact. Add mixed text/math, equation-only paragraphs and nearby unsupported inline constructs; inspect outputs independently rather than asserting only nonempty output.
- **Sequencing:** fix before broadly marketing rich native DOCX conversion; update support limits and rebuild exact native artifacts.

### F03 — Advertised web batches stop at the per-minute job limit

- **Category:** product behavior/reliability. **Severity:** medium. **Confidence:** confirmed.
- **Affected:** website users converting/compressing/extracting small, quickly processed batches.
- **Expected/actual:** the interface accepts up to 20 files and should complete or safely pause/resume them within service limits. An isolated eight-file upload succeeds, but Convert completes six jobs, then the seventh submission gets `429 Too many requests`; two rows remain ready.
- **Reproduction:** run `browser-probes.cjs` from the repo root. It runs the actual browser frontend and API with synthetic auth plus stub scanner/worker, so it isolates submission behavior from codec speed. Observe six accepted/completed conversion jobs and the displayed error.
- **Evidence:** [browser probe](audit-evidence/2026-10-04-comprehensive/browser-probes.txt), [screenshot](audit-evidence/2026-10-04-comprehensive/web-batch-limit.png); `server/app.cjs:427–429` allows six jobs/minute; `server/web/app.js:414–447` sequentially submits every selected file and stops on the first thrown 429. Upload reservations separately allow ten/minute (`app.cjs:242`), another source-supported mismatch with a fast 20-file batch.
- **Root cause:** per-file quotas and a batch-oriented UI are uncoordinated. The API does not provide a retry delay and the client does not checkpoint/pause around the quota. Pressing Convert again constructs specifications for all files, including prior completed work.
- **Impact/rating:** common small batches stall; retry can redo finished work and spend additional quota. Completed results/originals survive, so severity is medium. Live processing speed affects when the limit is encountered.
- **Correction:** keep abuse controls; implement a bounded resumable batch or explicit client pacing using server-provided retry information. Resume only unfinished jobs with stable identities. Explain quota waiting and retain cancellation/deletion.
- **Verification:** 8- and 20-file fast batches finish or visibly wait and resume without duplicate results; hourly limit and cancellation still work. Exercise delayed/rejected submissions, reload/resume and competing sessions using real API limits.
- **Sequencing:** change client/API behavior together; test before promoting a new web image.

### F04 — Native ZIP creation produces archives its own extractor rejects

- **Category:** archive compatibility/reliability. **Severity:** medium. **Confidence:** confirmed.
- **Affected:** native Mac/iPhone default compressed ZIP workflow; highly compressible text/log/data files.
- **Expected/actual:** a freshly created ordinary archive should round-trip within the app's disclosed limits, or creation should clearly explain incompatibility. A 1 MiB file of repeated `A` bytes creates a successful 1,152-byte ZIP, then Extract reports `Archive expansion ratio exceeds the safety limit`. The same file with ZIP compression disabled extracts successfully.
- **Reproduction:** supplied native probe creates, extracts, catches the rejection, then repeats in stored mode. It removes only its own conversion results.
- **Evidence:** [native probe](audit-evidence/2026-10-04-comprehensive/native-probes.txt); `Archives.swift:84–90` enforces 200×/1 GiB expanded limits; `:124–138` writes deflated entries without checking the resulting ratio/total against reader policy. Existing large ZIP test deliberately uses stored mode.
- **Root cause:** writer and reader accept different result sets. The reader's defensive ratio policy also rejects benign highly repetitive content. The writer can additionally accept media totals above the reader's 1 GiB expanded limit; that larger-file scenario is source-supported, not reproduced here.
- **Impact/rating:** users cannot reopen their own successful archives in Flux. Bytes remain recoverable through stored mode/other ZIP readers, and originals remain intact; medium severity.
- **Correction:** preserve hostile-archive controls. Align creation policy with extraction policy, e.g. store entries whose compression ratio would exceed limits, and reject/explain archive totals that Flux cannot extract. Make the fallback discoverable in Mac compression UX as well as the iPhone toggle.
- **Verification:** repetitive logs/JSON/zero-filled files and totals at policy boundaries round-trip or fail before success; CRC, links, duplicate names, encryption and expansion-abuse tests remain enforced.
- **Sequencing:** shared engine policy first, then UI messaging and native release rebuild.

### F05 — EPUB extraction changes chapter order and includes navigation content

- **Category:** document/ebook integrity. **Severity:** medium. **Confidence:** confirmed.
- **Affected:** native Mac/iPhone EPUB → TXT/MD.
- **Expected/actual:** extract primary text in the package's declared reading order. A fixture with spine `z-first.xhtml`, then `a-second.xhtml`, and a separate navigation document produces `SECOND CHAPTER`, navigation headings/links, then `FIRST CHAPTER`.
- **Reproduction:** convert supplied `ordered.epub` to TXT; compare its OPF spine to the output. Both chapters' source bytes are preserved in the fixture.
- **Evidence:** [native output](audit-evidence/2026-10-04-comprehensive/native-probes.txt); `Documents.swift:43–50` filters all HTML entries and sorts by filename, ignoring container/manifest/spine. The [EPUB spine specification](https://www.w3.org/TR/epub-33/#sec-spine-elem) defines default reading order.
- **Root cause:** ZIP directory enumeration substitutes for EPUB publication structure.
- **Impact/rating:** narrative/instructional text is reordered and non-reading resources contaminate the output. Formatting loss is disclosed, but changed sequence is a separate correctness defect. Medium severity because originals are retained and ordinary text still exports.
- **Correction:** resolve the rootfile from `META-INF/container.xml`, validate manifest-relative paths, and traverse primary spine references in order. Handle navigation/nonlinear resources intentionally; reject invalid/missing references rather than using filename order.
- **Verification:** reverse filenames, nested content paths, numeric chapter names, nonlinear items and separate navigation resources preserve declared primary order without extra content; malformed rootfile/spine cases fail safely.
- **Sequencing:** apply archive/XML protections to all newly parsed EPUB metadata.

### F06 — Short WebVTT timestamps become an unusable SRT result

- **Category:** subtitle correctness. **Severity:** medium. **Confidence:** confirmed.
- **Affected:** native Mac/iPhone VTT → SRT; valid `MM:SS.mmm` timestamps.
- **Expected/actual:** emit SRT cue indices and normalized `HH:MM:SS,mmm` timing. The valid VTT `00:01.000 --> 00:02.000` is published unchanged except removal of the WEBVTT header. FFprobe forced to read SRT finds **zero packets**. A control using hour-bearing timestamps yields one packet.
- **Reproduction:** convert supplied `short.vtt`/`hours.vtt` to SRT and run `ffprobe -f srt -show_entries packet=pts_time,duration_time -of json` on each output.
- **Evidence:** [conversion output](audit-evidence/2026-10-04-comprehensive/native-probes.txt), [independent decoder result](audit-evidence/2026-10-04-comprehensive/subtitle-validation.txt); `Documents.swift:159–170` only substitutes a regex requiring hours. The [WebVTT specification](https://www.w3.org/TR/webvtt1/#webvtt-timestamp) permits the short timestamp form and includes examples.
- **Root cause:** textual substitution is used in place of parsing/serializing subtitle cues. Cue numbering/settings/metadata also lack structural handling; those broader cases were inspected, not exhaustively reproduced.
- **Impact/rating:** a success-labeled subtitle result displays no captions in the independent decoder. Medium severity; source retained, other formats/routes offer recovery.
- **Correction:** parse cues, normalize timestamps and generate sequential indices; strip/translate WebVTT-specific settings and metadata deliberately or reject unsupported constructs.
- **Verification:** independent decoder finds the expected cue count, timing and text for short/full timestamps, Unicode, identifiers, settings, comments and malformed input. Test both directions and same-format behavior.

### F07 — Desktop format modal leaves keyboard focus behind the overlay

- **Category:** accessibility/interaction. **Severity:** medium. **Confidence:** confirmed.
- **Affected:** Electron users; same React modal bundled into native Mac (source-established applicability).
- **Expected/actual:** opening a modal places focus in it, confines Tab navigation, exposes dialog name/role and returns focus when closed. Opening PNG details with Enter leaves focus on the underlying PNG button. Five Tab presses select underlying PNG00/PNG24/PNG32/PNG48/PNG64 buttons while the modal remains visible. The format modal has no dialog role.
- **Reproduction:** All formats → search PNG → keyboard-focus PNG → Enter → Tab five times → Escape. Probe logs whether each active element is inside `.format-modal`.
- **Evidence:** [keyboard transcript](audit-evidence/2026-10-04-comprehensive/browser-probes.txt), [modal screenshot](audit-evidence/2026-10-04-comprehensive/desktop-modal.png); `src/main.jsx:1636–1680` lacks modal focus management/semantics; privacy modal at `:1608–1634` adds role/autofocus but no containment/restoration. [WAI's modal pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) describes expected interaction.
- **Root cause:** visual overlay and mouse dismissal are implemented without a complete modal interaction primitive.
- **Impact/rating:** keyboard users interact with obscured controls and cannot predict navigation. Screen-reader impact is strongly supported by semantics, but VoiceOver was not manually exercised. Medium severity for a supported input method.
- **Correction:** use a tested modal primitive or native dialog with explicit labeling, initial focus, background inertness, Tab containment, Escape and focus restoration. Apply it to format and privacy dialogs.
- **Verification:** Tab/Shift-Tab cannot reach obscured controls; Enter activates the visible dialog; Escape and Close restore the trigger; manually verify VoiceOver and native WebKit behavior.

### F08 — Desktop explanatory text has insufficient contrast

- **Category:** accessibility/readability. **Severity:** medium. **Confidence:** confirmed.
- **Affected:** Electron/native Mac users with reduced contrast perception; the shared desktop theme.
- **Expected/actual:** ordinary visible explanatory text reaches at least 4.5:1 foreground/background contrast. Computed modal styles measured **3.66:1** for 12px explanatory text (`#9a79b0`), **3.96:1** for 10px details (`#8b799b`), and **2.63:1** for the 8px conversion label (`#a89bb2`), each on white.
- **Reproduction:** open PNG format details; run supplied `contrast-probe.cjs`. It reads computed foreground/nearest opaque background and applies the sRGB relative-luminance calculation.
- **Evidence:** [computed values](audit-evidence/2026-10-04-comprehensive/contrast.txt), [visually inspected screenshot](audit-evidence/2026-10-04-comprehensive/desktop-modal.png); `src/styles.css:1449–1460, 1544–1547`; [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). These are small, visible informational text, not disabled controls or decoration.
- **Root cause:** low-contrast pastel values are used for information-bearing text. Small fixed font sizes amplify readability concerns, though size preference alone is not the defect.
- **Impact/rating:** users can miss output capabilities and limitations. Medium severity due to broad exposure and an objectively measured accessibility issue; no blanket assessment of every color or WCAG conformance.
- **Correction:** strengthen shared text tokens and check the desktop warning/status/result palette in all states. Retain clear non-color status labels.
- **Verification:** these elements meet the threshold from computed styles, plus manual low-vision/text-scaling assessment in Electron and native WebKit. Validate actual enabled/error/status states, not just screenshots.

### F09 — Advanced table routes bypass CSV schema validation

- **Category:** integrity/architecture/resource policy. **Severity:** medium. **Confidence:** confirmed for schema mutation; resource-exhaustion risk is strongly supported, not runtime-proven.
- **Affected:** Electron/shared server CSV/TSV → Parquet/Feather/NDJSON routes through Python.
- **Expected/actual:** duplicate/empty headers should have the same explicit validation policy across targets. `id,id\nfirst,second\n` is rejected by CSV → JSON, but CSV → Parquet succeeds and a JSON readback reports `{"id":"first","id.1":"second"}`. The schema was silently renamed.
- **Reproduction:** supplied `engine-probes.cjs` creates duplicate CSV, invokes both routes, then reads the Parquet output back to JSON through the real local Python engine.
- **Evidence:** [engine output](audit-evidence/2026-10-04-comprehensive/engine-probes.txt); `electron/engine.cjs:882–899` dispatches advanced targets before the guarded structured converter; `native/advanced.py:46–79` uses pandas `read_csv` without header validation or equivalent byte/row/cell/output limits. `native/advanced.py` and `resources/advanced.py` were byte-identical; the latter is the local Electron helper.
- **Root cause:** conversion-specific adapters independently define validation policy. Pandas' automatic column disambiguation is accepted as an ordinary successful conversion.
- **Impact/rating:** downstream joins/column mappings can use a schema different from the original; users receive no warning. Medium severity because values remain in the demonstrated output. Advanced table materialization also bypasses the JavaScript route's 50 MiB and cell limits; a container-wide OOM scenario was not induced and must not be presented as confirmed exploitation.
- **Correction:** establish shared byte/shape/schema/output policy before selecting the adapter, with independent enforcement within streaming Python processing. Reject duplicate/empty names consistently or require an explicit user-approved rename mapping. Keep SQLite read-only and formula escaping intact.
- **Verification:** all table targets reject the duplicate/empty-header fixture consistently, preserve valid headers, Unicode, booleans, numeric precision and row counts, and safely enforce size/cell/output bounds. Include schema assertions in Parquet/Feather/NDJSON round trips.
- **Sequencing:** coordinate with F01 to avoid merely moving precision loss to another serializer.

### F10 — Browser output notes stay stale after changing format

- **Category:** usability/product disclosure. **Severity:** low. **Confidence:** confirmed.
- **Affected:** website users choosing formats with different fidelity properties.
- **Expected/actual:** notes immediately describe the selected target. Changing JPEG → PNG leaves the JPEG-loss note. After a rerender establishes the PNG note, changing back to lossy JPEG leaves `PNG preserves pixels` visible until another render.
- **Reproduction:** browser probe selects PNG, navigates away/back to rerender, then selects JPEG; log the visible note after each action.
- **Evidence:** [browser probe](audit-evidence/2026-10-04-comprehensive/browser-probes.txt); `server/web/app.js:155` updates only the `targets` Map, while the note is created during `render()` at `:197–215`.
- **Root cause:** target selection state and its dependent disclosure are updated separately.
- **Impact/rating:** a user may initiate conversion after reading the prior target's preservation statement. The next render corrects the note, including when work starts, and originals remain intact; low severity relative to the semantic corruption above.
- **Correction:** update the note immediately when the target changes, preserving keyboard focus and selection rather than replacing the entire row unnecessarily.
- **Verification:** PNG/JPEG, raster/SVG and other materially different notes match the target before Convert is clicked; keyboard selection retains focus; asynchronous status updates do not overwrite edited save names.

## Verification results and evidence

All input data used for testing was synthetic. This audit used Apple Silicon macOS 27.2 (26B5091g), Xcode 27.0 (27A5237l; globally selected beta), Node v26.9.0 and npm 11.19.1. CI uses Node 24 and macOS 15; exact CI/environment parity was not rerun locally. Other host work was active, so these performance observations are not controlled benchmarks.

| Check performed this audit | Outcome | Evidence / interpretation |
| --- | --- | --- |
| `npm test` | **53 passed, 0 failed/skipped** | [JS output](audit-evidence/2026-10-04-comprehensive/node-tests.txt); real local formats plus synthetic server/security/lifecycle checks |
| Release SwiftPM test with isolated scratch path | **23 passed, 0 failed** | [native output](audit-evidence/2026-10-04-comprehensive/native-tests.txt); standard build command worked this run, so the earlier audit's native-build-system workaround was not required |
| `npm run test:desktop` | Passed | [Electron output](audit-evidence/2026-10-04-comprehensive/desktop-ui.txt); freshly built source UI with isolated state and mocked file dialogs; real engines/output files |
| `npm run test:web` | Single-file web suite passed; invite suite failed once; aggregate exited before login suite | [aggregate output](audit-evidence/2026-10-04-comprehensive/web-ui.txt); preserve the failure rather than claiming all suites passed |
| Invite repeat and synchronized diagnostic | Original repeat passed; synchronized variant passed **3/3** | [repeat](audit-evidence/2026-10-04-comprehensive/invite-ui-repeat.txt), [synchronized runs](audit-evidence/2026-10-04-comprehensive/invite-synchronized.txt) |
| Login redirect browser regression separately | Passed, three redirects | [login output](audit-evidence/2026-10-04-comprehensive/login-ui.txt); real synthetic JWT verification/local browser metadata; no live Cloudflare or Safari claim |
| Native safe-save policy check | Passed | [save output](audit-evidence/2026-10-04-comprehensive/mac-policy.txt); atomic replacement and preservation checks |
| Fresh native Mac Release build, signing disabled | Succeeded | [build summary](audit-evidence/2026-10-04-comprehensive/mac-build.txt); universal build configuration, no Intel runtime claim |
| Fresh native iPhone simulator Release build, signing disabled | Succeeded | [build summary](audit-evidence/2026-10-04-comprehensive/ios-build.txt); not a device IPA |
| iPhone simulator reviewer UI | Blocked / interrupted after prolonged simulator accessibility stall | Dedicated disposable iPhone 17 Pro/iOS 27.0; The XCTest intends to read policy, run five samples and exercise save cancellation/retry; this run stopped during the initial privacy check, before the sample conversions. Build alone is not UI acceptance |
| Existing packaged Electron path | Initial path missing; unpacked legacy ZIP workflow passed | [original attempt](audit-evidence/2026-10-04-comprehensive/packaged-ui.txt); [isolated package result](audit-evidence/2026-10-04-comprehensive/packaged-isolated.txt) and provenance details below |
| Independent fidelity/behavior probes | F01–F10 reproduced | [native](audit-evidence/2026-10-04-comprehensive/native-probes.txt), [engine](audit-evidence/2026-10-04-comprehensive/engine-probes.txt), [browser/keyboard](audit-evidence/2026-10-04-comprehensive/browser-probes.txt), [subtitle decoder](audit-evidence/2026-10-04-comprehensive/subtitle-validation.txt), [contrast](audit-evidence/2026-10-04-comprehensive/contrast.txt) |
| `npm run format:check`, Python AST syntax, archive helper equality, `git diff --check` | Passed | [format output](audit-evidence/2026-10-04-comprehensive/format-check.txt); Python source parsed without producing bytecode; no application code modified |
| `npm audit --json` | Zero reported advisories in resolved JS tree | [scan JSON](audit-evidence/2026-10-04-comprehensive/npm-audit.json); does not cover Apple/native/FFmpeg/Python/OS engine vulnerabilities or unknown advisories |
| 512 MiB native streaming copy | 0.6323 seconds inside copy; **10,076,160 bytes peak RSS** (~9.61 MiB) | [measurement](audit-evidence/2026-10-04-comprehensive/copy-performance.txt); `/usr/bin/time -l`, sparse repeated-zero file, warm/local filesystem, single run; verified output length, not a real-media/device throughput claim |
| 50,000-record native table round trip | Passed; ~0.241 seconds test measurement | [native tests](audit-evidence/2026-10-04-comprehensive/native-tests.txt); synthetic records, no iPhone RSS/battery extrapolation |
| Docker/container/production run | Blocked: Docker CLI unavailable | Source and mocked protocol tests only. ClamAV, gVisor, Linux tools, actual resource ceilings and live recovery need deployment-host evidence |

### Test quality observation: the revocation browser check is race-prone

`tests/invite-ui.cjs:48–50` clicks Revoke, then immediately reloads the guest. The click handler awaits an asynchronous DELETE, but Playwright's click completion does not wait for that request. One run left the guest workspace visible and timed out; the unchanged test passed on repeat. An isolated diagnostic waiting for the successful member DELETE before reloading passed three times. Access unit tests also passed. This supports a **test synchronization defect**, not a confirmed authorization bypass. The application source and original test were left unchanged. Gate on the completed mutation/visible owner-state change in the test; add explicit failure/cancel/reload assertions without removing authorization checks.

### Strengths and practical verification limits

The implementation has meaningful isolation and integrity work: narrowed renderer bridges; opaque native file IDs; disabled remote WebKit resources; safe staging/publication; explicit process environments and bounded output; parser deadlines/cancellation; guarded XML/YAML; ZIP preflight and CRC; owner-scoped API data; signed JWT validation; atomic invitation persistence; bounded queue/chunks/scratch/container configuration. Tests check several actual file formats, preserved bytes/decoded pixels/encoded packets/glyph outlines and relevant races rather than relying solely on snapshots. These observed/source-tested controls reduce specific risks, but parser vulnerabilities, actual OS enforcement and production configuration remain outside the established runtime evidence.

Native deadlines are cooperative, and synchronous Apple framework work cannot always stop immediately. Native files/results are cached privately; originals and user-saved copies are not part of cleanup. Server conversion scratch is ephemeral, membership persists, and a container update erases temporary conversion work. Atomic rename/copy tests are not power-loss durability proofs. Advanced Python materialization deserves safe workload profiling before increasing file limits.

## Remediation roadmap

| Order | Work | Risk reduction and dependency | Completion evidence |
| --- | --- | --- | --- |
| Immediate | Prevent F01 numeric corruption; reject unsupported inline DOCX math for F02 | Stop plausible-looking incorrect exports before attempting richer rendering | Exact numeric tokens/values, independent PDF/HTML content assertions, no successful partial artifact |
| Immediate | Align F03 batch behavior and F04 ZIP writer/reader policy | Restore reachable primary workflows while retaining quotas/archive defenses | Fast 8/20-file resumable batches; compressed/stored archive boundary round trips and hostile archive suite |
| Near term | Structural EPUB and subtitle parsing (F05/F06); shared table validation (F09) | Fix ordering/timing/schema semantics and policy drift; coordinate precision with F01 | Spine/cue/schema fixtures independently decoded/read back on both native targets and server adapter |
| Near term | Modal interaction and shared text contrast (F07/F08); immediate notes (F10) | Make supported controls usable through keyboard/low-vision workflows and accurate before confirmation | Keyboard tests plus manual VoiceOver/Dynamic Type/contrast audit on exact native/Electron builds |
| Near term | Stabilize invite UI synchronization; extend tests to semantic outputs and batch boundaries | Make checks detect the new defects without weakening auth/limits | Repeated browser flow, preserved failing fixture regression, required CI/browser gate where feasible |
| Before release promotion | Rebuild exact native/Electron/container artifacts; verify hash/source correspondence, signatures, sandbox and clean-machine behavior | Separate working source from stale/unsigned packages and deployed state | Build receipts, package scan/launch, native real pickers/provider saves, actual gVisor/ClamAV/cgroup/restore run |
| Longer term | Safe profiling of Python large tables, physical-device memory/thermal/background/low-storage testing, malformed corpus expansion and observability/restore drills | Reduce unknown performance/recovery/native-parser/deployment risks | Representative measured workloads, private crash diagnostics, fail-closed behavior and practiced recovery |

Optional/product decisions, kept separate from defects: expanding the native format catalog, OCR/language support, richer Office layouts, a persistent native history, translating the UI, stronger container digest pinning/SBOM provenance, and a friendlier quota waiting screen. Existing limits, local-only architecture and lossiness disclosures are intentional constraints; do not remove them simply to pass a corpus.

## Release-readiness assessment

- **Native Mac/iPhone:** source builds and shared-engine checks succeed, but F02 and medium native fidelity/ZIP findings prevent a broad document/conversion-readiness claim. Correct/reject them, then verify real native Mac panels, physical iPhone Files export/provider access, background cancellation, low storage and memory. Require exact signed artifacts and independent output inspection before tester promotion.
- **Electron:** ordinary local conversion/compression/archive UI works in the source-run acceptance suite. F01 and accessibility findings remain. The legacy developer ZIP passed its isolated Office workflow and ad-hoc signature verification, but its main/engine hashes differ from current source; it cannot validate a corrected release. The full MAS engine portability/redistribution gate remains an independent prerequisite, not solved by native build success.
- **Website/container:** frontend/API normal path and security regressions run locally, but F01/F03/F09/F10 remain and production isolation/scanning is not verified. Run the actual container smoke/scan/gVisor/resource/restart checks on an isolated deployment-host environment before deciding to update `stable`/Unraid. No live services or users were contacted by this audit.
- **External distribution:** no App Store/TestFlight status, production image digest, tester installation or user acceptance was checked. A prior document's review-ready/VALID assertion is historical evidence, not a current release result. LGPL/native-engine redistribution and exact App Store privacy declarations require appropriate specialist/release review; this audit does not certify them.

## Open questions, limitations, and audit changes

1. Which exact native and server artifacts are installed/available now? Resolve via signed/hash receipts and production/App Store read-back when that access is explicitly in scope; it was not needed to establish the local defects.
2. Native Mac real save/open panels and VoiceOver were not manually operated this run. Mocked Electron dialogs do not grant native sandbox/file-provider authority or prove bookmark relaunch behavior.
3. Physical iPhone, iOS 18.4, Intel execution, Safari/Edge, third-party Files providers, large real media, reduced motion, large Dynamic Type/RTL and long-session operation remain gaps.
4. Docker/Unraid/ClamAV/gVisor/seccomp enforcement, Cloudflare's actual MFA/host policy, malware definition age, production volume mounts, rollback/boot recovery and live public support metadata were not verified. No third-party system was probed.
5. Resource/attack tests were isolated and bounded. Disk-full, container OOM, real secrets and private documents were deliberately not used; there is no claim of a full penetration test or exhaustive fuzzing.
6. The ten findings distinguish local observed behavior from inferred platform scope and follow-up risks. All most-severe output findings were rechecked with independent readback; duplicates were consolidated. No findings were invented for categories without an observed defect.

**Created:** this report and `docs/audit-evidence/2026-10-04-comprehensive/` (logs/summaries, synthetic fixtures, reproducible diagnostic sources and screenshots). **Runtime environment changes:** isolated temporary test directories, Swift/Xcode builds/caches, loopback test servers, temporary Electron/Chromium sessions and a disposable simulator; normal tests regenerated ignored `dist` and `.test-output` content. Only the audit documents/evidence are intended new tracked files. No original user files, signing settings or release commands were modified. The owned simulator was shut down/deleted, and its stalled test was interrupted. No other simulator or chat was modified. Final artifact outcomes are recorded below.

Full build/UI result logs and the XCTest result bundle live under `/tmp/flux-comprehensive-audit-20261004`; concise sanitized evidence is retained in the repository. The evidence README describes reproduction and scope. These are audit fixtures/diagnostics, not newly committed application tests or repairs.

### Final simulator and package outcomes

The iPhone reviewer UI test launched the freshly built app in a dedicated iPhone 17 Pro/iOS 27.0 simulator. It found/tapped the privacy button, then stalled while querying the `offline-privacy` accessibility element. Nominal ten-second waits took over two minutes; no further useful progress followed. The run was interrupted after approximately eighteen minutes, and Xcode reported `BUILD INTERRUPTED` with test-log finalization diagnostics. Duplicate WebKit accessibility-class and debugger lookup warnings were present. These observations do **not** establish a privacy-screen app defect or identify the stall's cause. The five sample conversions and Files export/cancel/retry UI flow remain **blocked/unverified** this run. The successful source build and shared-engine tests are separate evidence. The audit's simulator was shut down and deleted; the log and incomplete local result bundle were preserved. See [UI summary](audit-evidence/2026-10-04-comprehensive/iphone-ui.txt).

The original `node tests/packaged.cjs` could not launch because its expected `release/Flux.app` was absent. The existing `release/Flux-1.0.1-local.zip` was instead unpacked into an isolated temporary folder; only executable/module paths in a temporary copy of the test were changed. Its relocated Office/Python checks and desktop DOCX → PDF → DOCX flow **passed**. `codesign --verify --deep --strict` also **passed**; the app is arm64 and ad-hoc signed without a TeamIdentifier, which is not notarization or App Store distribution approval. Its `electron/main.cjs` and `electron/engine.cjs` hashes differ from current source. Therefore this legacy package result must not be attributed to the audited commit or used as evidence that corrections reached users. Original release files were not modified. See [package output](audit-evidence/2026-10-04-comprehensive/packaged-isolated.txt), [hash comparison](audit-evidence/2026-10-04-comprehensive/package-provenance.json), [signature metadata](audit-evidence/2026-10-04-comprehensive/package-signature.txt) and [verification receipt](audit-evidence/2026-10-04-comprehensive/package-verify.txt).
