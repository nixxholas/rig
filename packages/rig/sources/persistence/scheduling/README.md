# Scheduling persistence

These operations store restart-safe waits and scheduled messages.

```text
durable_waits       scheduled_messages
      │                      │
      └── session restore    └── one daemon-wide due-time timer
```

Every mutation writes a complete scheduling record through the common asynchronous transaction
facade before the session changes its in-memory copy.
