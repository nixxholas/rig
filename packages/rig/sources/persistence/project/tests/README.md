# Project persistence tests

These tests cover project persistence consistency boundaries against isolated SQLite databases.
They observe committed and rolled-back durable state through the public operations in the parent
directory.

```text
test fixture --> project operation --> SQLite
      ^                                |
      +--------- durable state --------+
```
