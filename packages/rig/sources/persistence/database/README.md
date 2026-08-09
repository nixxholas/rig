# Persistence database

This directory owns the asynchronous SQLite connection, its `asyncLock`, the Drizzle schema, and
schema lifecycle. A database is either created from the initial migration or atomically reset when
it belongs to an older Rig generation.

```text
openSessionDatabase
        |
        v
SessionDatabase (client + asyncLock + Drizzle database)
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
contains the immutable released migration sequence as awaited asynchronous implementations. It is
the only migration source and runtime path. Tests create isolated database files and live in
`tests/`.

`SessionDatabase` is the lifecycle owner. Plain persistence work enters through `inDatabase` or
`inTx`, which acquires its lock. A Drizzle transaction already owns the connection, so nested work
reuses that transaction without reacquiring the lock. `close()` is an awaited lifecycle boundary:
admitted work drains first, then the owner transitions from closing to closed and rejects new work.

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
data on the current schema, initialized data that needs an ordinary upgrade, recognized
pre-identity Rig data that needs its first identity migration, data from an incompatible newer
schema, and data that is temporarily or permanently unavailable to inspect.
`uninitialized` is reserved for an empty or recognized data state that normal startup can
initialize safely. Garbage, corruption, or a broken committed identity is `unavailable` and must
not be presented as safe to initialize or reset.
For a valid SQLite database with a foreign application identity, safe initialization means the
normal startup transaction deliberately discards its foreign tables before creating Rig's schema.
Recognized Rig schemas from before migration 20 are `upgrade_required` with reason `pre_identity`;
they have existing Rig data but cannot expose an epoch until normal daemon migration commits one.
