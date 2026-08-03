# Murmur persistence tests

These tests use isolated temporary SQLite databases to verify the durable
Murmur storage boundary.

```text
test
  |
  v
SqliteMurmurStore
  |
  v
temporary private SQLite files
```

They cover copied values across reopening, transaction rollback, serialized
operations, and removal of every account-state file after close.
