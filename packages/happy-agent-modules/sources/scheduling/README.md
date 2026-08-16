# Scheduling

Scheduling is a provider-neutral module for durable agent waits and scheduled messages. It owns its
durable wait and scheduled-message tables through Agent Base migrations. Every database operation
uses the active Drizzle facade from `ctx.db`; the host supplies only the external wait/delivery
scheduler.

```ts
const scheduling = new SchedulingModule({
    scheduler, // host-owned start/wait/schedule/cancel/delivery operations
});
```

Every caller supplies a context carrying the Agent Base database. Every agent receives `wait` and
`wait_until`. `schedule_message` is included only when the injected `scheduleMessagePolicy`
allows the calling agent; when the policy is absent it is denied, so a host must explicitly supply
the role-aware policy for non-subagents. The model-facing schedule tool accepts a required
`agent_id` and can target any known agent. A host caller can pass `targetAgentId`, but cross-agent
scheduling is denied unless the injected authorization policy grants it.

Waits plan and finalize a durable record in short transactions while both host claim and suspension
run outside them, then settle the authoritative terminal record in another short transaction.
New chat messages interrupt the host wait. Results are explicitly `elapsed` or
`interrupted` and include the actual elapsed milliseconds, which the model rendering turns into
human-readable English. Durations accept seconds, minutes, hours, and days as discrete or
compound fields, plus human text such as `90 seconds` or `1h 30m`.

`wait_until` and scheduled-message `at` values accept ISO 8601, RFC 2822, and Unix timestamps in
seconds or milliseconds. A past instant is clamped to the current clock so the operation resolves
immediately. Waits remain bounded to 24 hours by default. Scheduled messages use the same default
horizon, which a host can raise with `maxScheduleHorizon` up to the module timestamp bound.

Scheduled messages have `pending`, `delivered`, `undelivered`, and `cancelled` states. Delivery
attempts, failure details, retention, and process recovery belong to the host. The module exposes
`schedule`, `cancelSchedule`, `listSchedulePage`/`listSchedule`, `getSchedule`/`getSchedulePage`,
and `reportDeliveryOutcome`. Every host schedule, cancellation, and delivery callback runs outside
database transactions. Catalog finalization follows in a short transaction. The scheduler must
reconcile a repeated operation with the same schedule ID and identical input, allowing a retry to
finish catalog persistence after a finalization rollback without duplicating the external effect.
Scheduling does not maintain a second receipt, proof, fingerprint, replay, or operation-state
layer. Only database-only tools use `transactional: true`; host-backed tools remain unwrapped.

Transactional and post-commit listeners receive one detached, deeply frozen event object for each
changed mutation: `wait_started`, `wait_finished`, `message_scheduled`,
`scheduled_message_cancelled`, or `scheduled_message_delivery_outcome`. Post-commit listener
failures are contained and optionally reported to `onPostCommitError`; registration uses stdlib
`afterCommit(ctx, callback)`.

Scheduling is the sole owner of the `schedule_message` tool name. Collaboration does not expose
scheduled messages; the orchestrator can select this module's tool surface directly.
