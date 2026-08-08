# Folder persistence tests

These tests cover the folder tree's consistency boundaries against isolated SQLite databases. They
observe durable state through the public operations in the parent directory, and through
`FolderRepository`, which is where tree order, drag-and-drop order keys, and refusals are decided.

```text
test fixture --> FolderRepository --> folder operation --> SQLite
      ^                                                     |
      +--------------------- durable state -----------------+
```
