# Timeline persistence

This directory reads the two things a timeline is made of: the agents a scope covers, and the
durable lifecycle events those agents produced. Both are `query` operations over the shared `TX`
facade, and neither writes anything — a timeline is derived from history that Rig already keeps.

```text
       timeline scope
             |
   +---------+---------+
   v                   v
queryTimelineAgents  queryTimelineEvents
   |                   |
   v                   v
 sessions rows     session_events rows
             \     /
              v   v
           buildTimeline
```

A project scope reaches every workspace and chat inside it, a workspace stops at that worktree, and
a session covers itself together with its subagents at any depth, resolved with a recursive walk
over `parent_session_id`.

Event reads narrow to the handful of lifecycle types in SQL before any payload is deserialized, so
a chart never loads the long tail of streamed history it does not draw. The
`session_events(session_id, type, seq)` index exists for exactly this query.
