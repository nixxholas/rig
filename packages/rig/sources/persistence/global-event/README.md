# Global event persistence

This directory owns the complete SQLite operations for the durable global event stream. Reads are
named with the `query` prefix; mutations append events, advance the trim watermark, or reset the
stream. Every operation accepts the shared `TX` database-or-transaction facade as its first
argument.

```text
PersistentGlobalEventQueue
          |
          v
  global-event operations
     |             |
     v             v
event rows     trim watermark
     \             /
      v           v
        SQLite database
```

Startup reads the latest stored cursor together with the trim watermark so cursor generation
continues after whichever is newer. Listing preserves cursor order, applies the optional exclusive
cursor and limit, and maps stored JSON back into protocol events. Trimming updates both retained
rows and the watermark in one transaction, which keeps stale-cursor detection valid after restart.
