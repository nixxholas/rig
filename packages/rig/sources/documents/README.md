# Documents

`DocumentRepository` owns opaque live documents.

```text
HTTP identity -> immutable createdBy
CAS write -> current state + exactly one update -> post-commit document_changed
```

Rig canonicalizes and bounds JSON but never interprets app-defined state or updates.
