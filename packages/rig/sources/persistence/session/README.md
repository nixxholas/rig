# Session persistence

This directory contains synchronous, semantic database operations for sessions. Each top-level
TypeScript file exposes one complete mutation or one `query` operation. Every operation receives
the shared `TX` facade first so it can run directly or compose inside a transaction.

```text
session model / store
        |
        v
one persistence operation
        |
        +--> TX --> SQLite
        |
        +--> impl/ decoders
```

Mutations persist a complete consistency boundary. Queries preserve the ordering, limits, and
decoding required by their callers. Database representation helpers live in `impl/`, and operation
tests live in `tests/`.
