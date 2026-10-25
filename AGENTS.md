# File converter: agent instructions

Read `README.md` before working here. Preserve concurrent changes and follow the current task scope.

## App-local worktrees (owner instruction, 25 October 2026)

The canonical app folder is `/Users/sequoyahgeber/dev/File converter`. Keep this app's source, manual worktrees and new task outputs inside that folder, using its existing ignored output locations. Do not create sibling worktrees in `~/dev`, another app's folder, or the Studio's product-workspace area.

- Put manual linked worktrees in `<canonical-app-folder>/.worktrees/<task>`. Existing app-local `.claude/worktrees/` is also allowed. From a linked worktree, resolve the canonical app folder from the parent of `git rev-parse --path-format=absolute --git-common-dir`; do not nest another `.worktrees/` under the current linked worktree.
- Keep `/.worktrees/` ignored in the main repository and the shared `.git/info/exclude` so older branches cannot accidentally stage it. Scope scans/builds to source directories and prune worktree directories from recursive whole-app scans.
- Reuse a suitable released worktree when safe. Before moving one, check active jobs, Git registration, local changes, submodules and path consumers. Use `git worktree move` (or a verified move plus `git worktree repair` for submodules), preserving staged, unstaged, untracked and ignored files.
- After work is integrated and pushed, remove its inactive worktree only after preserving local-only settings, originals and evidence. Never infer that ignored files are disposable.
- Existing tool-managed checkouts outside the app remain owned by that tool; retire them with its lifecycle tools. For new routine work, choose an app-local manual worktree instead of a mode that forces a checkout outside the app.

This placement instruction supersedes older examples that put worktrees beside the app or in a central worktree folder. It does not authorize deleting unfinished work, changing release policy, or moving protected originals.
