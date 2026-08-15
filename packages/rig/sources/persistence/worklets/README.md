# Worklet persistence

`RigWorkletCatalog` is the SQLite host port consumed by
`WorkletsFeature`. The feature owns catalog behavior, filesystem installation,
version changes, receipts, proofs, and events; Rig only supplies durable rows and
the shared transaction boundary.
