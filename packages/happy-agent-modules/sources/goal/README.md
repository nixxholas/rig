# Goal module

`GoalModule` stores one current goal per agent and keeps an active goal moving until it is
completed, blocked, paused, or cleared. One module instance serves the collection.

The host supplies its shared `AgentStorageTransaction`. Public reads and mutations each use one
transaction. The module persists only current goal state, the active lifecycle, and the current
failed-turn count; it has no operation receipts, mutation proofs, fingerprints, or call-scoped
replay records.

The four model tools are durable. Each tool calls `AgentToolCall.commit` inside the same
transaction as its Goal read or mutation. `create_goal` uses the stable cuid2 `call.id` as the new
goal lifecycle identity. Agent Base owns tool retry and completion.

An activation made outside the owning agent also enqueues its wake in the mutation transaction.
Transactional listeners run before commit and post-commit listeners run through `afterCommit`.