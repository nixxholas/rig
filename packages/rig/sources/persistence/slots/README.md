# Slot persistence

These operations store slot entries: agent-authored content plugged into fixed Happy UI slots.

Each entry carries its scope reference, TypeBox-validated content as JSON, and the author session
with a description and purpose. Reads filter in SQL before any content payload is deserialized, and
scope targets are checked inside the writing transaction so a dangling reference becomes a typed
API rejection rather than a foreign-key crash.
