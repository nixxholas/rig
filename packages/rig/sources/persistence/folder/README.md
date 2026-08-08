# Folder persistence

This directory owns synchronous SQLite operations for the folder tree and for the folder a chat is
filed into. Every operation accepts the shared `TX` facade first. Public reads use the `query`
prefix; mutations retain any reads needed inside their complete consistency boundary.

```text
folders/FolderRepository
      |
      v
query / mutation operation
      |
      +----> impl/ row mapping
      |
      v
    TX facade
      |
      v
   SQLite folders + sessions.folder_id
```

Nesting is virtual: a folder's `parent_id` places it in the tree while its `path` is a flat storage
directory named after its own id, so `folderMove` rewrites rows and never the disk. Query
operations preserve tree order, sibling order keys, and archive state; `folderArchive` puts a whole
subtree away at once. Tests for these public persistence boundaries live in `tests/`.
