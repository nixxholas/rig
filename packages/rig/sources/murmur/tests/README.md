# Murmur tests

These tests exercise the Murmur domain contract with isolated in-memory stores
and a deterministic relay transport.

They cover profile image normalization and ThumbHash generation, public
key-only account responses, the pending-to-accept/reject friend-request
lifecycle, and stop/delete reopening behavior. No live relay or filesystem
database is required.
