# Goal module

`GoalModule` stores one current goal per agent and keeps an active goal moving until it is
completed, blocked, paused, or cleared. One module instance serves the collection.

```text
goal mutation
    │
    ├─ durable goal state + event ──> commit
    │                                  └─ host interrupt (when needed)
    └─ active turn failure/abort ─────> paused goal
```

Every database operation uses the root or active transaction facade from `ctx.db`. Public
multi-write mutations compose through `ctx.inTx`, while transactional hooks reuse the transaction
Agent Base already opened. The module persists only current goal state, the active lifecycle, and
the current failed-turn count; it has no operation receipts, mutation proofs, fingerprints, or
call-scoped replay records.

The four model tools are durable and set `transactional: true`, so Agent Base owns the transaction
through execution, validation, rendering, and result completion. The module never calls
`AgentToolCall.commit`. `create_goal` uses the stable cuid2 `call.id` as the new goal lifecycle
identity.

An activation made outside the owning agent also enqueues its wake in the mutation transaction.
Transactional listeners run before commit and post-commit listeners run through `afterCommit`.
Agent Base turn failures, interruptions, and agent archival pause an active goal through
transactional module hooks.

The optional `GoalHost` seam lets the host enforce primary-session-only management, set an idle
session title from a new goal, and interrupt active work after a pause, block, clear, failure,
interruption, or archival. Without that seam, Goal remains usable: all agents may manage goals,
titles are unchanged, and only Goal's durable state is updated.
