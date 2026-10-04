# Fix verification receipts

See [the implementation record](../../audit-fixes-2026-10-04.md) for the F01–F10 mapping and limitations. This folder records corrected-source checks; the adjacent `2026-10-04-comprehensive` folder retains original failing-output evidence.

- `node-tests.txt`: 56 local engine/security/server regressions, including the new precision and real Python adapter checks.
- `precision-tests.txt`: the source-aware precision test also used by CI; one selected test, no claim of a remote CI run.
- `native-tests.txt`: 28 shared-engine native regressions; compiler chatter omitted.
- `desktop-ui.txt`: real Electron engines with synthetic inputs/isolated state; mocked file dialogs. Includes keyboard modal containment/restoration, computed contrast and rejection of the precision fixture through the real main process.
- `web-ui.txt`: complete web/invite/login/batch suites. The final quota-wait behavior is additionally recorded in `batch-ui.txt`.
- `batch-ui.txt`: real local API/frontend quotas with controlled clocks and stub codecs/scanner. Twenty- and eight-file batches, waiting cancellation, nondefault output choices through reload, failed-job retry and no duplicate successful results.
- `native-probes.txt`, `subtitle-validation.json`: supplied audit inputs read through corrected shared native source; FFprobe independently reads the corrected subtitle packet.
- `contrast.txt`: computed ratios for the three reported text failures.
- `mac-policy.txt`, `format-check.txt`: safe-save and source-format gates.
- `mac-build.txt`, `ios-build.txt`: unsigned Release build summaries; full compiler logs in `/tmp/flux-audit-fixes-20261004`.
- `support-generation.txt`: offline/local public support generation; no publishing.
- `probe-Package.resolved`: dependency pins for the independent native probe.
- `source-hashes.json`: selected modified/new implementation and regression files at final verification.
- `SHA256SUMS.txt`: retained evidence hashes, excluding the manifest itself.

Reproduce from the repository root with `npm test`, `npm run test:desktop`, `npm run test:web`, `npm run test:mac`, `npm run format:check` and `swift test --package-path native/OfflineKit --scratch-path /tmp/flux-fix-repro -c release`. Engine/UI tests require the repository's existing local conversion tools, Python runtime, Electron and Playwright Chromium. The diagnostic native probe and synthetic fixture setup are described in [the original evidence README](../2026-10-04-comprehensive/README.md); its output now reflects corrected behavior. Set an isolated `FLUX_AUDIT_ROOT` and scratch path as documented.

These receipts do not establish physical-device acceptance, live production security enforcement, exact signed distribution or installation. The legacy Electron release ZIP was left byte-identical. No personal documents, live users, signing secrets or production data were used.
