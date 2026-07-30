# Persistence database tests

These tests use isolated SQLite database files to verify database initialization, reset behavior,
schema parity, and transaction boundaries.

```text
test or fixture
       |
       v
openSessionDatabase --> migrateSessionDatabase --> SQLite file
```

`createSessionDatabaseFixture.ts` prepares a minimal initialized database for consumers that need
a persistent Happy session.
