# Git

This directory is the filesystem-facing Git layer every other module borrows. It owns Git command
execution, repository probing and identity checks, worktree creation/removal, safe remote cloning,
credential brokering, workspace transfer, revision reads, change scanning, and bounded live
tracking. It has no database, protocol, catalog, or HTTP coupling.

It is a plain domain module: no `AgentModule` hooks, no migrations, no tools. Nothing here is
registered with the agent system — the projects and workspaces catalogs receive it and do their own
Git work through it, which is why a catalog needs no host object to be complete.

Foreground mutations use `GitCommandRunner`; unattended reads use `runScanGit`, which disables
prompts, optional locks, lazy fetches, hooks, credential helpers, fsmonitor, and external diff
programs while bounding time and output. Worktree deletion and adoption rely on both top-level and
shared common-directory identity, and refuse symbolic-link destinations.

`scanGitRepository` compares the branch with its merge base against `origin/main`. It combines
committed, staged, unstaged, conflicted, and untracked work; detects binary files; keeps totals
separate from the capped display list; omits files larger than the display limit; and carries both
old and new bytes for binary deltas that remain displayable.

`GitStateTracker` is intentionally persistence-free. Callers supply plain snapshot and live-event
callbacks. The tracker requires the application `RootContext`, creates its own named lifetime, and
uses caller contexts for explicit refresh/watch interactions.

Import the complete surface from `./index.js`, or import one coherent operation directly.
