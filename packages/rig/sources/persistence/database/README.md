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

`rig_data_identity` is the authoritative initialized marker. Its singleton epoch is inserted in
the same transaction as migration 20, stays stable across ordinary opens and migrations, and is
replaced when a foreign or obsolete data generation is atomically reset. Read-only installation
inspection never creates or migrates the database: no file is `absent`, a file without the current
committed identity is `uninitialized`, and only the current application ID, schema version, and
identity row are `initialized`.
