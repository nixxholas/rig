# File search tests

These tests exercise the public file-search service against isolated temporary
workspaces.

```text
temporary workspace
        |
        v
 FileSearchService
        |
        v
relative fuzzy matches
```

HTTP route integration remains in `server/tests`.
