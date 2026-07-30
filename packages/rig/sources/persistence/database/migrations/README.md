# Database migrations

Each file in this directory is one ordered schema migration. Migrations execute synchronously
inside the database migration transaction and must describe one complete schema transition.

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
