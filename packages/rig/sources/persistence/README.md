# Persistence

This module owns every asynchronous SQLite read and mutation. Each operation receives
`DatabaseScope` first,
so it works through the database lock or composes into the current transaction through `inTx`.

```text
domain model or repository
            |
            v
  persistence operation
            |
            v
  DatabaseScope
            |
            v
  inDatabase / inTx
            |
            v
          SQLite
```

`database/` owns the Drizzle schema, connection setup, and fresh-schema migration. The domain
directories own semantic operations and their representation helpers. Shared transaction and
database-failure boundaries stay at this level. Tests for those shared boundaries live in `tests/`.
