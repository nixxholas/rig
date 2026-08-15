# Scheduling

Scheduling is a provider-neutral module for an agent's own time. It owns its durable wait and
scheduled-message tables through Agent Base migrations. Every database operation uses the active
Drizzle facade from `ctx.db`; the host supplies only the external wait/delivery scheduler.

```ts
const scheduling = new SchedulingModule({
    scheduler, // host-owned start/wait/schedule/cancel/delivery operations
});
```

The host transaction is optional when Scheduling is used only through Agent Base hooks and tools,
because those contexts already carry the active Drizzle facade; direct host calls made without an
active database must provide it. Every agent receives `wait` and `wait_until`. `schedule_message` is included only when the
injected `scheduleMessagePolicy` allows the calling agent; the module never guesses whether an
agent is a subagent. The model-facing schedule tool has no target field and always schedules to
the calling agent itself. A host caller can pass `targetAgentId`, but cross-agent scheduling is
denied unless the injected authorization policy grants it.

Waits claim a durable record in a short transaction, suspend through the host scheduler outside
that transaction, and settle the authoritative terminal record in a second short transaction.
New chat messages interrupt the host wait. Results are explicitly `elapsed` or
`interrupted` and include the actual elapsed milliseconds, which the model rendering turns into
human-readable English.

Scheduled messages have `pending`, `delivered`, `undelivered`, and `cancelled` states. Delivery
attempts, failure details, retention, and process recovery belong to the host. The module exposes
`schedule`, `cancelSchedule`, `listSchedulePage`/`listSchedule`, `getSchedule`/`getSchedulePage`,
and `reportDeliveryOutcome`. Scheduling does not maintain a second receipt, proof, fingerprint,
replay, or operation-state layer. Single-transaction model tools set `transactional: true`, so
Agent Base commits their durable results when execution returns. Waits cannot do that because the
host wait remains outside the narrow start and settle transactions; their terminal scheduling
record commits before the tool's separately managed durable result.

Transactional and post-commit listeners receive one detached, deeply frozen event object for each
changed mutation: `wait_started`, `wait_finished`, `message_scheduled`,
`scheduled_message_cancelled`, or `scheduled_message_delivery_outcome`. Post-commit listener
failures are contained and optionally reported to `onPostCommitError`; registration uses stdlib
`afterCommit(ctx, callback)`.

Scheduling is the sole owner of the `schedule_message` tool name. Collaboration does not expose
scheduled messages; the orchestrator can select this module's tool surface directly.
