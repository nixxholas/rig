# File-tree tests

These tests cover the transport-independent lazy directory contract: physical
hidden and ignored entries, protected Git paths, traversal and symlink
boundaries, cursor invalidation, mutation during a first page, and bounded
pagination of a large flat directory.

HTTP and Happy RPC wiring are covered by their package-level transport tests.
The Docker filesystem has both a command-contract unit test and an Alpine
container test beside its implementation.
