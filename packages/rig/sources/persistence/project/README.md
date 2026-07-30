# Project persistence

This directory owns synchronous SQLite operations for projects, managed workspaces, and project
avatar metadata. Every operation accepts the shared `TX` facade first. Public reads use the
`query` prefix; mutations retain any reads needed inside their complete consistency boundary.

```text
project/ProjectRepository
      |
      v
query / mutation operation
      |
      +----> impl/ row mapping
      |
      v
    TX facade
      |
      v
SQLite projects + workspaces + avatar assets
```

Query operations preserve project and workspace ordering, project-scoped workspace identity,
case-insensitive storage reservations, initialization and archive state, and avatar references.
Tests for these public persistence boundaries live in `tests/`.
