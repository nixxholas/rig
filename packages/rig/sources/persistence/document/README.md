# Document persistence

Documents store canonical JSON state and a bounded ordered update queue.

```text
CAS document write -> replace state -> append one update -> trim queue -> receipt
```

The complete write is one synchronous SQLite transaction.
Write receipts use the same per-document count bound as retained updates, so
traffic on another document cannot evict an ambiguous retry.
