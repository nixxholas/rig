# Compactions

Typed, durable lifecycle for every provider context-compaction attempt. One module instance serves
the full agent collection and owns a SQLite table recording manual and automatic starts, terminal
outcomes, run association, and exact before/after context measurements.

```text
manual API request ─┐
                    ├─ running row ── provider outcome ── completed / failed
automatic policy ──┘                         │
                                            └─ first later inference records tokensAfter
```

## Public surface

- `startManual(ctx, agentId)` creates and publishes the running resource before asking Agent Base
  to compact. A second running attempt throws `CompactionAlreadyRunningError`.
- `get(ctx, compactionId)`, `running(ctx, agentId)`, and `listPage(ctx, agentId, query)` read the
  durable source of truth. Pages are newest first, default to 50 rows, and cap at 100.
- `onEventTransactional` and `onEvent` publish `compaction_created` and `compaction_updated` around
  the same commit that changes storage.

The module takes `EventsModule` to associate automatic compaction with the exact active public run,
and `UsageModule` to seed a manual attempt with the latest exact context measurement. No caller
supplies IDs, run handles, clocks, or token estimates.

## Lifecycle and recovery

Agent Base's stable compaction ID correlates the start, history replacement, and provider outcome.
Successful replacement is marked completed inside the same transaction that replaces model
history. Failed and canceled outcomes become failed resources with a human-readable reason. The
agent-settlement transaction is a backstop for provider exceptions that never returned a typed
outcome.

Completed compactions retain `tokensAfter` as absent until the first later inference reports the
replacement context's exact input-plus-output size. An incompatible model reset clears that pending
association instead of attributing the new model's unrelated context.

At startup, every row left running by the previous process is failed before the daemon becomes
ready. Realtime delivery is therefore only a hint: a reconnecting client reads the table through the
API and never remains stuck on stale compacting state.

## Storage

Migration `001-durable-compactions` creates `happy_agent_compactions`, a stable insertion sequence
for opaque-ID paging, a unique Base-attempt correlation, and a partial unique index allowing at most
one running compaction per agent. Rows are retained as durable history and are never loaded without
a page bound except for the startup scan of the one-running-per-agent set.
