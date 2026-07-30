# Session persistence tests

These tests exercise the public consistency boundaries in the parent session persistence module.
They use an isolated SQLite database and observe durable results rather than implementation
helpers.

```text
test fixture --> persistence operation --> SQLite
      ^                                  |
      +----------- durable result -------+
```
