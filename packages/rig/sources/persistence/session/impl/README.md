# Session persistence implementation

This directory holds mechanical helpers shared by session persistence operations. They decode
SQLite rows and persisted JSON envelopes but do not issue database queries themselves.

```text
query or mutation
      |
      +--> SQLite row
      |       |
      |       v
      +-- impl decoder --> domain value
```

Keep semantic database operations at the parent directory's top level.
