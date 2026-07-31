# project tests

These tests cover the observable project and workspace lifecycle, including
project identity normalization, durable-event rollback, Git worktree behavior,
archival, ordering, avatar lifecycle, and platform-specific managed-workspace
roots.

```text
tests
  |
  +--> ProjectRepository
  |       |
  |       +--> persistence/project
  |       +--> git
  |
  +--> projectIdentity
```

The tests use isolated temporary directories and in-memory SQLite databases
where persistence behavior needs to be observed.
