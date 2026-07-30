# Persistence

This module owns every synchronous SQLite read and mutation. Each operation receives `TX` first,
so it works directly against the database or composes into the current transaction through
`inTx`.

```text
domain model or repository
            |
            v
  persistence operation
            |
            v
       TX / inTx
            |
            v
          SQLite
```

`database/` owns the Drizzle schema, connection setup, and fresh-schema migration. The domain
directories own semantic operations and their representation helpers. Shared transaction and
database-failure boundaries stay at this level. Tests for those shared boundaries live in `tests/`.
