# Worklet persistence

Small database operations for the global worklet catalog and its immutable version history.
Runtime state, source trees, icons, logs, and durable worklet data live outside SQLite and are
owned by the worklet store and manager.

Callers compose these operations inside explicit transactions where a multi-row transition must be
atomic.
