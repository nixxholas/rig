# Folder persistence implementation

This directory contains the database-row mapping used by folder query operations. The helper
translates the SQLite representation into a protocol folder without issuing queries.

```text
query operation --> SQLite row
                         |
                         v
                  impl row mapper
                         |
                         v
                  protocol value
```

Semantic reads and complete mutations stay at the parent `folder` directory's top level.
