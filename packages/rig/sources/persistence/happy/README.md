# Happy persistence

This directory owns asynchronous SQLite operations for Happy session synchronization and its
outbox. Queries use the `query` prefix, and mutations preserve their complete consistency
boundaries through `DatabaseScope`, `inDatabase`, and `inTx`.

```text
HappySyncRepository
        |
        v
Happy query or mutation
        |
        v
      TX / inTx
        |
        +--> happy sessions
        +--> Happy outbox
```

Credential rotation, session state, outbox acknowledgement, and remote sequence advancement are
all represented as semantic operations rather than repository-local SQL.
