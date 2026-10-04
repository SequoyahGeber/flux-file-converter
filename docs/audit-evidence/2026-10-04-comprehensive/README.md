# Comprehensive audit evidence — 4 October 2026

Read [the report](../../audit-comprehensive-2026-10-04.md) for interpretation, severity and limits. This folder retains sanitized logs, small synthetic inputs, screenshots and diagnostic sources. It does not contain fixes or a new application test suite. The audited source was clean `main` at `4e96283e37ddd377b55d1baefa4947f765c02356`; see `environment.json` for toolchains.

## Reproduce the independent probes

Run from the repository root on a Mac with the repository's existing dependencies and engines available. The browser scripts require Playwright Chromium and Electron; the Python-backed table check requires pandas/pyarrow in the detected Python engine. The native probe requires Xcode/Swift and the existing OfflineKit dependencies/XCFramework. Do not use personal input files. These commands create a fresh temporary folder, use isolated Electron state, and keep Swift build output outside the evidence folder:

```sh
audit_work=$(mktemp -d /tmp/flux-audit-repro.XXXXXX)
audit_evidence="$PWD/docs/audit-evidence/2026-10-04-comprehensive"
cp "$audit_evidence"/fixtures/{short.vtt,hours.vtt,ordered.epub,equation.docx,precise.json,duplicate.csv} "$audit_work/"
(cd "$audit_work" && python3 "$audit_evidence/fixtures/make-repeat.py")

FLUX_AUDIT_ROOT="$audit_work" node "$audit_evidence/engine-probes.cjs"
FLUX_AUDIT_ROOT="$audit_work" swift run --package-path "$audit_evidence/probe" --scratch-path "$audit_work/swift-build" -c release AuditProbe

npm run build
FLUX_AUDIT_ROOT="$audit_work" node "$audit_evidence/browser-probes.cjs"
FLUX_AUDIT_ROOT="$audit_work" node "$audit_evidence/contrast-probe.cjs"
```

`engine-probes.cjs` compares JSON precision and duplicate-header behavior using real local conversion engines. `probe/` invokes public OfflineKit APIs for the VTT, EPUB, DOCX, precise-number control and compressed/stored ZIP round trips. It removes only results from its own conversions, leaving copies of content outputs in the temporary folder for inspection. `browser-probes.cjs` runs the real web frontend/API locally with synthetic authentication and a stub scanner/worker: its web results establish frontend/quota behavior, not actual codec or malware-scanner behavior. It then launches the source Electron UI to test keyboard modal focus. `contrast-probe.cjs` reads computed small-text colors and calculates sRGB contrast.

Independent readback, using the repository's existing Python runtime and installed FFprobe:

```sh
resources/python-runtime/bin/python3 - "$audit_work/equation.docx.pdf" <<'PY'
import sys, pymupdf
with pymupdf.open(sys.argv[1]) as document:
    print(repr("".join(page.get_text() for page in document)))
PY
ffprobe -v error -f srt -show_entries packet=pts_time,duration_time -of json "$audit_work/short.vtt.srt"
ffprobe -v error -f srt -show_entries packet=pts_time,duration_time -of json "$audit_work/hours.vtt.srt"
```

Current defective behavior is deliberately recorded: equations are absent, short-timestamp SRT has zero packets, EPUB chapter order is reversed, the compressed ZIP rejects extraction, JSON numbers change on the JavaScript path, duplicate CSV columns rename on the advanced path, six web jobs complete before a 429, and focus remains behind the modal. These diagnostics print observations; they are not green/red regression gates. After repairs, turn the expected semantics into required assertions.

## Existing checks and outcomes

| Command/check | Retained evidence | Scope |
| --- | --- | --- |
| `npm test` | `node-tests.txt` | 53 pass; local formats and isolated server/security tests |
| `swift test --package-path native/OfflineKit --scratch-path /tmp/flux-comprehensive-audit-20261004/swift-build -c release` | `native-tests.txt` | 23 pass; summarized test output |
| `npm run test:desktop` | `desktop-ui.txt` | Fresh source build; isolated state, mocked dialogs, actual engines |
| `npm run test:web` | `web-ui.txt` | Web suite passed; invite suite failed once; aggregate stopped before login |
| `node tests/invite-ui.cjs` repeat | `invite-ui-repeat.txt` | Unchanged test passed on repeat |
| Isolated synchronized invite diagnostic, three runs | `invite-synchronized.txt`, `invite-ui-synchronized.cjs` | Waits for successful revoke DELETE before guest reload; original tests unchanged |
| `node tests/login-ui.cjs` | `login-ui.txt` | Separate signed synthetic login regression passed |
| `npm run test:mac` | `mac-policy.txt` | Native atomic safe-save checks |
| `npm run format:check` | `format-check.txt` | Existing source format gate |
| `npm audit --json` | `npm-audit.json` | Zero resolved-JS advisories; no native/OS/Python certification |
| Independent conversion/UI checks | `engine-probes.txt`, `native-probes.txt`, `browser-probes.txt`, `subtitle-validation.txt`, `contrast.txt` | Outputs underlying F01–F10; synthetic data only |
| Native streaming sparse 512 MiB copy, `/usr/bin/time -l` | `copy-performance.txt` | Single warm/local run; output length checked, not device throughput |
| Fresh unsigned native Mac/iPhone simulator builds | `mac-build.txt`, `ios-build.txt` | Successful Release build summaries; full commands/logs in temporary directory |
| iPhone reviewer UI attempt | `iphone-ui.txt` | Blocked/interrupted accessibility-query stall; no completed sample-conversion/export UI acceptance |
| Existing Electron package | `packaged-ui.txt`, `packaged-isolated.txt`, `package-provenance.json`, `package-signature.txt`, `package-verify.txt` | Initial expected path absent; isolated existing ZIP test and ad-hoc signature verify passed; main/engine hashes differ from audited source |

The synchronized invite diagnostic can be run as `node "$audit_evidence/invite-ui-synchronized.cjs"` from the repository root. It retains the original test's synthetic local accounts and mocked worker/scanner; it does not contact Cloudflare or users. The run count is the shell's three independent invocations, not a loop within the diagnostic.

Screenshots show only synthetic local UI: `desktop-modal.png`, `web-batch-limit.png`, `web-mobile.png`. Compiler commands were omitted from large build summaries; the full logs and incomplete XCTest bundle remain under `/tmp/flux-comprehensive-audit-20261004`. The dedicated simulator was shut down/deleted. No other simulator, live service, signing configuration or original release artifact was modified.

`SHA256SUMS.txt` records this retained folder's file bytes, excluding itself. Fixture generation is deterministic for the repeated-byte ZIP input; the other fixtures contain only audit text/numbers. Additional malformed/hostile inputs came from existing isolated tests and are not personal documents.
