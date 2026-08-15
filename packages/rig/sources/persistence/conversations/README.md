# Conversation persistence

This directory contains asynchronous, semantic database operations for conversations. Each top-level
TypeScript file exposes one complete mutation or one `query` operation. Every operation receives
the shared `DatabaseScope` first so it can acquire the owner lock or compose inside a transaction.

```text
conversation repository / protocol projection
        |
        v
one persistence operation
        |
        +--> inDatabase / inTx --> SQLite
        |
        +--> impl/ decoders
```

Mutations persist a complete consistency boundary. Queries preserve the ordering, limits, and
decoding required by their callers. Database representation helpers live in `impl/`, and operation
tests live in `tests/`.
