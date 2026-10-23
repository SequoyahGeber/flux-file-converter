# Flux documentation index

Start with the [root README](../README.md). This index lists each document's role and which one is the current source of truth. Last reviewed 23 October 2026 (documentation-only cleanup; nothing was built, tested or released).

## Source boundaries

| Area | Source | Notes |
| --- | --- | --- |
| Native Mac app | `mac/`, [mac/README.md](../mac/README.md) | Swift/WKWebView; shares `native/OfflineKit` |
| Native iPhone app | `ios/`, [ios/README.md](../ios/README.md) | SwiftUI; same App Store Connect record as Mac |
| Shared native engine | `native/OfflineKit/`, `native/VERSION` | Swift package with a checked-in FFmpeg XCFramework |
| Web client and server | `src/`, `server/`, `deploy/`, `Dockerfile`, `compose.yaml` | Separate Unraid/Cloudflare converter; not embedded in the native apps |
| Electron desktop | `electron/` | Legacy desktop path; see AUD-001 in [AUDIT_BACKLOG.md](../AUDIT_BACKLOG.md) |
| Public site | `docs/site/` | Packed into `release/flux-site.zip` by `scripts/prepare-beta-resources.py` |

## Current source of truth

| Topic | Document |
| --- | --- |
| Beta review and submission checklist | [beta-review.md](beta-review.md) |
| App Review notes text (reviewer walkthrough) | [beta-review-notes.txt](beta-review-notes.txt) |
| Build, test and TestFlight procedure | [testflight.md](testflight.md) |
| Personal full-engine Mac build (not distributable) | [mac-full-engine.md](mac-full-engine.md) |
| Privacy policy / support (markdown sources) | [privacy.md](privacy.md), [support.md](support.md) |
| Open findings | [AUDIT_BACKLOG.md](../AUDIT_BACKLOG.md) |

## Beta checklist (index)

The checklist is spread across the files above. Use this order:

1. Confirm the target record, version and build in [beta-review.md](beta-review.md) and `native/VERSION`.
2. Regenerate samples and site resources with `scripts/prepare-beta-resources.py`; deploy `release/flux-site.zip` to the `flux-site` Cloudflare Pages project.
3. Run the engine, `ReviewerAccessTests` and Mac walkthrough checks listed in [beta-review.md](beta-review.md) and [testflight.md](testflight.md).
4. Build signed artifacts with `scripts/mac-release.py` and `scripts/ios-release.py`; validate and upload the exact hashed artifacts ([testflight.md](testflight.md)).
5. Run `python3 scripts/beta-review.py <build>` (read-only preflight). `--apply-metadata` and `--submit` change App Store Connect state.
6. Keep the reviewer text in [beta-review-notes.txt](beta-review-notes.txt) in step with the screens.
7. Submission is not approval: confirm Apple's final review state before enabling any public group.

## Historical audit records

Dated records; they describe the commits they audited, not current behavior. Read each report with its fix record.

| Date | Audit | Fix record | Evidence |
| --- | --- | --- | --- |
| 4 Oct 2026 | [stability/safety/performance](audit-2026-10-04.md) | in the comprehensive audit's fix record | `audit-evidence/2026-10-04/` |
| 4 Oct 2026 | [comprehensive](audit-comprehensive-2026-10-04.md) | [audit-fixes-2026-10-04.md](audit-fixes-2026-10-04.md) | `audit-evidence/2026-10-04-comprehensive/`, `audit-evidence/2026-10-04-fixes/` |
| 6 Oct 2026 | [application audit](audit-2026-10-06.md) | [audit-fixes-2026-10-06.md](audit-fixes-2026-10-06.md) | `audit-evidence/2026-10-06/` |

## Local-only output (ignored by Git)

`dist/` (web build), `node_modules/` (needed by `npm test` and Electron), `release/` (signed archives, receipts and the site zip) and `.test-output/` (logs and verification proof that `scripts/beta-review.py` reads) are ignored but not disposable. Do not delete `release/` or `.test-output/` without an owner decision.
