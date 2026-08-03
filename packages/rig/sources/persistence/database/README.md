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
replaced when a foreign or obsolete data generation is atomically reset.

Offline installation inspection never starts or contacts the daemon, creates the database or its
directory, acquires the daemon lock, or creates daemon socket, token, or log state. It does perform
an authoritative read through SQLite. When an existing database is using WAL mode, SQLite may
create or retain transient `-wal` and `-shm` bookkeeping beside it even for a read-only connection;
those SQLite files may remain after inspection. They are database bookkeeping, not daemon
lifecycle state.

The inspection contract distinguishes absent data, present but uninitialized data, initialized
data on the current schema, initialized data that needs an ordinary upgrade, data from an
incompatible newer schema, and data that is temporarily or permanently unavailable to inspect.
