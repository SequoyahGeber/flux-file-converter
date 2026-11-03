# Audit backlog

Rolling audits verify and log findings here; **do not implement fixes during audit work**. Entries remain open until
resumed project work implements and verifies a correction. No production files or live application state were used.

## AUD-001 — Stage cleanup deletes unrelated directories in the chosen output folder

- **Status:** FIXED — marker-based ownership (`.flux-stage-owner`), regression test `tests/stage-ownership.test.cjs`.
- **Severity:** High / P1 (recursive deletion of user-owned content without confirmation or Trash recovery).
- **Affected revision:** `a42015430bf2085693d8bd791a92eb16e99615b7` (local and remote main checked October 15, 2026).
- **Paths:** `electron/engine.cjs:909–918` (`sweepStages`); `electron/main.cjs:432–439` (batch startup).
- **Scope:** the Electron desktop batch path. This finding does not assert that the native Mac or server path calls
  the same cleanup function, or that every distributed Flux build includes it.

### Trigger and reproduction

The user may select an arbitrary output directory. Before starting its next batch, the Electron handler calls
`sweepStages(destination)`. That function recursively deletes every directory whose name matches
`^\.flux-[A-Za-z0-9]{6}$`, without an ownership record or marker. The normal hidden directory name `.flux-backup`
therefore qualifies even when Flux did not create it.

Safe reproduction used a newly created disposable directory only:

1. Create `.flux-backup/synthetic.txt`, `.flux-A1b2C3/synthetic.txt`, `ordinary/synthetic.txt`, and `source.txt`, all
   containing invented data. Confirm the backup marker exists.
2. Invoke the actual exported `sweepStages` from the unchanged engine with that disposable directory.
3. Check the files again, then remove only the owned audit directory.

Observed output:

```json
{"backupBefore":true,"backupAfter":false,"ordinaryAfter":true,"originalAfter":"invented original","appStyleStageAfter":false}
```

The helper successfully removed the unrelated backup directory along with the app-style staging directory; the
ordinary folder and original control file remained intact. No converter, malformed input, installed app or real
output folder was needed. The repository's existing tests contained no `sweepStages` case when searched.

Local reproduction and evidence: rolling-audit workspace `audit/flux-stage-preservation.cjs` and
`audit/flux-stage-preservation.log`. The isolated checkout's runtime source was unchanged.

### Suggested next-session fix

Track and validate stage ownership instead of inferring it from a basename. Prefer an app-owned private staging
root or a durable list/marker of stages actually created for this output location. Unknown legacy matches should
be preserved or explicitly reviewed, not deleted automatically. Retain tests that preserve `.flux-backup` and other
unrelated directories while cleaning only positively owned abandoned stages. Review interrupted jobs and symlink
handling before considering the finding resolved; do not silently sweep users' existing folders during migration.

### Other executed coverage and limits

- Nine existing selected tests passed: cancellation/process descendants, partial writes, distinct archive identities,
  exclusive-copy fallback preserving an existing result, late inspection cancellation, concurrent capacity admission,
  abandoned-upload cleanup, shutdown ordering and cancellation before a worker starts.
- Two more existing tests passed: failed scans cannot publish results, and failed chunk writes release upload capacity.
- Existing native `SafeSave` checks passed for failed saves preserving an old destination, successful replacement,
  creating new files, and refusing to replace an existing extracted folder.
- Node `v26.9.0`; repository dependencies were read from the existing local installation without installing packages.
  Tests used owned temporary files, fake scanners/workers and localhost fixtures. The Swift safe-save executable was
  built in `/tmp`; no installed app or personal files were accessed.
- Evidence: `audit/flux-preservation-tests.log`, `audit/flux-recovery-tests.log`, `audit/flux-safe-save.log`.
- This is not full converter, GUI, removable-volume, production-container or physical-device acceptance.

No implementation/test/workflow files were changed by this documentation commit. The container workflow's `build`
job skips ordinary branch pushes, and stable promotion is guarded to release tags or manual dispatch; no release tag,
manual release, image publication or deployment is part of this audit.


## AUD-002 — File-drop overlay remains after dropping a file and blocks the app

- **Tracking:** `FLUX-DROP-OVERLAY-001` in the Studio task board.
- **Status:** FIXED — 29 October 2026, in the 1.0.3 native Mac release after build 2026100305. Regression tests are in `tests/drag-state.test.cjs`.

### Resolution (29 October 2026)

Commit `1f1ce68` added a drag tracker and a native drag-end signal, but a real Finder drop on a signed development
build still reproduced the stuck overlay. That build had two faults:

1. `src/dragState.mjs` called `setTimeout`/`clearTimeout` as methods of a plain object. WebKit throws "Can only call
   Window.clearTimeout on instances of Window", so `end()` failed before it could hide the overlay. Node does not
   enforce this, which is why the unit tests passed. The default timers are now wrapped functions.
2. `LocalDesktopWebView.draggingEnded` called `super.draggingEnded`, but WKWebView does not implement that optional
   `NSDraggingDestination` method. The resulting exception inside AppKit's drag completion
   (`NSCoreDragCompletionProc`, then "Reentrant message … kDragIPCCompleted") left the drag session stuck, so every
   later drag was ignored. The super call is now guarded by `instancesRespond(to:)`.

Real macOS validation used a signed development build of the fixed source and disposable synthetic PNGs dragged from
Finder. The overlay appeared while hovering and cleared on drop for three successive drops into the background
window. A cancelled drag (in and back out to Finder) cleared the overlay and added nothing. All three dropped files
then converted, and the Choose files and sample flows still worked. AppKit logged no drag exceptions. The tests
reproduce both faults: a `this`-checking timer host, and a source guard on the `draggingEnded` super call.
- **Severity:** High / P1 — drag-and-drop leaves the interface unusable and requires force-quitting.
- **Platform:** macOS, reported for Flux File Converter; exact app variant/version/build and macOS version not supplied.
- **Observed source revision:** repository HEAD `3480ff4`; this is not a claim that the installed affected build was produced from that commit.

### Owner-reported reproduction

1. Open Flux File Converter.
2. Drag a file from Finder (including Downloads) onto the app.
3. Release the file over the drop target.

**Actual:** The drag/drop-location overlay remains covering the whole app screen after the drop. It blocks further interaction; the owner reports having to force-quit and reopen the app. No conversion success, crash, or data loss is established by this report.

**Expected:** The drag overlay dismisses when the drop is completed or cancelled, the dropped file is handed to the normal import flow (or an accessible error is shown), and the app remains usable.

**Workaround confirmed by owner:** Choose File, then select the file in Finder's file picker. That path works.

### Follow-up and acceptance

Identify the affected native/Electron variant and build, reproduce using a disposable synthetic file, and inspect the drag-enter/exit/drop state lifecycle before diagnosing a cause. Verify successful drop, rejected/unsupported input, cancelled drag, leaving/re-entering the window, and repeated drops all clear the overlay and keep controls interactive. Preserve the working Choose File path. Add a focused regression for the actual lifecycle fault and perform real macOS UI validation. Implementation, tests, and independent reproduction are pending; this entry logs the report only.


## AUD-003 — Cancelling a Ghostscript PDF compression leaves `gs_*` files in the temp folder

- **Status:** OPEN
- **Severity:** Low / P3 (three zero-byte files per cancelled job; no data loss, but they accumulate in a long session and are never swept).
- **Found by:** long-session soak `FLUX-BL-012`, record in `docs/audit-evidence/2026-11-03-soak/`.
- **Paths:** `electron/compression.cjs` (`compress`, the `lossy` PDF branch that runs `engines.ghostscript`); `electron/process.cjs` (`run`, SIGTERM then SIGKILL after 1.5 s on abort). Engine code was not changed.
- **Scope:** the in-process Electron engine. The server isolates each job in a supervised worker and the native Mac app was not soaked, so neither is claimed affected or clear.

### Trigger and reproduction

Cancel a lossy ("Smaller PDF") compression while Ghostscript is running. `run` signals the process group, and the
`gs_*` files Ghostscript creates in `TMPDIR` stay behind. That the termination prevents Ghostscript's own cleanup is
inferred from the timing (completed Ghostscript jobs leave nothing), not traced inside the tool. The engine passes
`TMPDIR` through to its tools, so the files land in the temp folder rather than the job's stage, and the stage
cleanup does not cover them.

```
npm run soak -- --iterations 300 --seed 1 --out <scratch>/soak.json
```

Exit code 1, finding `temp`. The soak points `TMPDIR` into its own scratch root, so nothing outside it is touched. The
run is timing-dependent (abort delays are real time): the other 300-job runs of seed 1 on this Mac ended with 3 and
6 leftover files.

### Observed numbers

- 300 of 300 jobs completed: 280 ok, 9 failed as expected (corrupt inputs), 11 cancelled, 0 unexpected failures.
- Job 103, a cancelled `compress` lossy PDF, took the temp folder from 0 to 3 entries (`gs_` plus six characters,
  0 bytes each). It was the only cancelled Ghostscript job in the run; the other 10 Ghostscript jobs completed and left nothing.
- The same run showed no other finding: open file handles 13 at baseline and at the end, no child process alive,
  no `flux-paths-*` alias, no `.flux-*` stage left, heap 13.2 MiB at baseline and 14.5 MiB at the end (slope
  4.7 KB/job, below the 64 KiB limit), RSS flat.
- Limit: the native PDF tool (`pdf` engine) was not installed, so PDF to PNG/text routes were skipped and the
  Ghostscript path was the only PDF route that ran.

### Suggested next-session fix

Give each Ghostscript run a private `TMPDIR` inside the job stage (for example by passing an `env` override through
`run`), so the existing `finally` that removes the stage also removes anything the tool abandons. Alternatively list
and remove the job's `gs_*` files after a cancelled run. Re-run the soak command above and expect exit 0, then add a
regression test that cancels a Ghostscript job and checks the temp folder.
