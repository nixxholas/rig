# File search

This module owns workspace file-name indexing and fuzzy search. It keeps a
bounded least-recently-used set of FFF indexes and returns protocol-facing
relative paths.

```text
HTTP file-search route
          |
          v
  FileSearchService
          |
          +--> FFF workspace index
          |
          v
  FileSearchResult[]
```

The server owns request authentication and response formatting. This module
owns index lifecycle, initial scan readiness, search execution, and eviction.
Callers must close the service during daemon shutdown.

Tests live in `tests/`.
