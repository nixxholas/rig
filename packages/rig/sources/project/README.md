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

`projectIdentity.ts` owns display-name normalization and portable storage-key
generation used by both this module and project persistence.

Tests for this module live in `tests/`.
