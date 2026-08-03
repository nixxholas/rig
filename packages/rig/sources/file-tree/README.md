# File tree

This module owns lazy workspace directory browsing. It lists one directory at a
time through the session's `FileSystemContext`, enriches only the requested page
with metadata, and returns an opaque stateless cursor.

```text
Happy listFileTree RPC ──┐
                         ├── listFileTree ── FileSystemContext
project file-tree HTTP ──┘                       │
                                                ├── native
                                                ├── Docker
                                                └── JustBash
```

The API never walks a repository recursively and never constructs a whole-tree
snapshot. Response size, native paging memory, remote output, path depth, and
metadata batches are bounded. Docker resolves a page's metadata in one
container command rather than one command per entry. Cursors are bound to the
requested directory and its fingerprint; `reason: "directory_changed"` asks an
RPC caller to restart from the first page. A cursor-less first page is
best-effort and remains usable while builds are writing the directory.

Names use deterministic UTF-8 byte ordering. This deliberately does not group
directories ahead of files: doing so requires metadata for every child before
the first page. A client may visually distinguish entry types but must preserve
the server order while paging.

Stateless sorted pagination trades time for bounded memory. Native paging scans
the requested directory for each page while retaining only the smallest page of
names. Docker uses the container's external sort with bounded host output.
JustBash sorts its whole listing because its filesystem is already an in-memory
test/runtime implementation. None of these costs depend on the size of the
repository outside the one directory explicitly expanded by the caller.

`.git` directories are intentionally absent and cannot be traversed, including
case variants on case-insensitive filesystems. Ordinary files such as
`.gitmodules` remain visible. Other hidden or ignored entries are ordinary
filesystem entries, so Rig's `.context` scratch directory and empty directories
appear naturally. Symlinks are listed but cannot be expanded. Paths use
portable POSIX-relative syntax; a filename containing a backslash can be
displayed but not expanded on its own because backslash is a separator on
Windows.

Tests live in `tests/`.
