# project

This module owns project and managed-workspace lifecycle behavior. It turns a
directory into one project, provisions and archives workspaces, manages avatar
files, coordinates Git worktrees, and emits the project events that the daemon
publishes after a successful database commit.

```text
server through the session store facade
                  |
                  v
ProjectRepository
       |
       +--> persistence/project   SQLite reads and mutations
       +--> git                   repository probes and worktree actions
       +--> utils                 paths and ordering
       |
       v
project and workspace events
```

`ProjectRepository` is deliberately SQL-free. Persistence operations own all
database access and receive `TX`; the repository owns lifecycle work around
those operations, including filesystem cleanup and Git orchestration.

Explicit registration validates an absolute folder as a readable canonical Git
top-level before entering the same path import used by session resolution.
Registration accepts both a repository's primary checkout and linked worktree
roots, is idempotent by canonical path, and restores an archived project instead
of creating another entity. The import and its durable event commit in one
transaction.

`getManagedWorkspacesDirectory.ts` selects the user-facing root for new
workspaces: `~/Happy/Workspaces` on macOS, `~/happy/workspaces` on Linux, or
the absolute `RIG_WORKSPACES_DIRECTORY` override. A workspace's absolute path
is persisted when it is reserved and remains authoritative for later lifecycle
operations, so changing the root affects new workspaces without relocating old
ones. Internal assets continue to use the separate state directory.

`projectIdentity.ts` owns display-name normalization and portable storage-key
generation used by both this module and project persistence.

Tests for this module live in `tests/`.
