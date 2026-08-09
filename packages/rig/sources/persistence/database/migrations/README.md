# Database migrations

Each file in this directory is one ordered asynchronous schema migration. Every database
operation is awaited inside the migration transaction, and each migration must describe one
complete schema transition.

```text
migrateSessionDatabase
        |
        v
ordered migration functions
        |
        v
 SQLite schema version
```

`01-init.ts` creates the entire current schema for a fresh Rig database. It deliberately has no
compatibility or backfill path because older database generations are reset before initialization.

Released migration numbers, order, conditional behavior, and SQL are immutable. Add each new
schema version as the next numbered asynchronous migration.
