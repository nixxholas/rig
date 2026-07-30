# Global events

This module owns the queues that order events across sessions, projects, and
workspaces.

```text
session and project models
          |
          +--> LiveGlobalEventQueue ------> local live clients
          |
          +--> GlobalEventQueue
                 |
                 +--> InMemoryGlobalEventQueue
                 |
                 +--> PersistentGlobalEventQueue
                              |
                              v
                  persistence/global-event
```

`LiveGlobalEventQueue` keeps a bounded replay window for local clients.
`InMemoryGlobalEventQueue` provides a bounded process-local stored stream.
`PersistentGlobalEventQueue` stores durable entries through TX-first
persistence operations and retains only cursor and subscription state in
memory.

All queue cursors are monotonic UUIDv7 values. Stored events keep their cursor
across replay, while live-only deliveries deliberately have no durable cursor.
The classification helpers decide which session events belong in the durable
stream. HTTP and SSE framing remain in `server`; database queries and mutations
remain in `persistence/global-event`.

The `tests` directory covers queue ordering, replay gaps, live fan-out,
classification, rollback, and cursor validation.
