# Murmur persistence

This directory contains the durable SQLite `MurmurStore` used for a local
Murmur account. Its private, separate database keeps Murmur keys, encrypted
messages, identity state, relay cursors, and outbox records outside Rig's
session schema.

```text
Murmur client
      |
      v
SqliteMurmurStore
      |
      +--> serialized operation gate
      |
      +--> BEGIN IMMEDIATE / COMMIT
      |
      v
murmur_key_values in private SQLite, WAL, and SHM files
```

The adapter copies byte arrays at its boundary, bounds keys and values, and
serializes all asynchronous calls while using synchronous SQLite internally.
`close()` must complete before `deleteDatabaseFiles()` can remove the database,
WAL, and shared-memory files during account deletion. The latter is idempotent
so deletion can be retried after an interruption.

Tests in `tests/` cover durability, atomic rollback, private file permissions,
and complete post-close deletion.
