# Workspace file search

This module owns the fuzzy file-name index used by composer `@` mentions and the workspace file
search API. Each active index is rooted at one canonical project or child-workspace folder.

```text
workspace root ──> FFF path index ──> ranked relative file paths
                         │
                         └── background filesystem watcher
```

Indexes are created lazily and kept in least-recently-used order. The module retains at most eight
indexes by default; eviction and shutdown destroy the native finder so its watcher and memory are
released. File contents are not indexed.
