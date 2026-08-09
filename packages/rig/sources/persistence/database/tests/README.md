# Persistence database tests

These tests use isolated SQLite database files through the asynchronous `SessionDatabase`
foundation to verify database initialization, reset behavior, schema parity, and transaction
boundaries.

```text
test or fixture
       |
       v
openSessionDatabase --> migrateSessionDatabase --> SQLite file
```

`createSessionDatabaseFixture.ts` prepares a minimal initialized database for consumers that need
a persistent Happy session. Database work is awaited; plain operations use the session
`asyncLock`, while transaction-scoped operations reuse the existing transaction handle.
`migrationAsyncContract.test.ts` verifies that the single migration history stays contiguous,
exports asynchronous migrations, and awaits every database operation.
