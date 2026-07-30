# Persistence database

This directory owns the synchronous SQLite connection, Drizzle schema, and schema lifecycle. A
database is either created from the initial migration or atomically reset when it belongs to an
older Rig generation.

```text
openSessionDatabase
        |
        v
Drizzle database + SQLite client
        |
        v
migrateSessionDatabase
        |
        +--> migrations/01-init
        |
        v
      schema.ts
```

`schema.ts` is the typed Drizzle representation of the initialized database. `migrations/`
contains ordered schema changes. Tests create isolated database files and live in `tests/`.
