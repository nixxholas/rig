# Project persistence implementation

This directory contains the database-row mapping used by project query operations. The helpers
translate the SQLite representation into protocol projects and workspaces without issuing queries.

```text
query operation --> SQLite row
                         |
                         v
                  impl row mapper
                         |
                         v
                  protocol value
```

Semantic reads and complete mutations stay at the parent `project` directory's top level.
