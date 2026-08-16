# @slopus/happy-agent-base

The minimal durable runtime for Happy agents.

`AgentBase` owns one agent's persistent inference and tool loop. It durably queues messages,
streams provider responses, executes tools, compacts history, resumes interrupted work, and
keeps inference, tool results, and settlement transactionally consistent across process
restarts.

The package also provides the primitives needed to host that runtime:

- `Agent`, `AgentSystem`, and `AgentSystemLocal` for composing and addressing agents;
- Drizzle-backed `AgentStorage` and scoped `AgentKV` for durable state;
- `AgentProviders` for resolving provider/model routes;
- `AgentTool` and lifecycle hooks for extending the loop.

One `AgentSystem` exclusively owns one durable store. `AgentStorage` requires an asynchronous
Drizzle SQLite or PostgreSQL/PGlite database plus a hard database-level lock. It owns the agent
record, key-value, and migration tables itself. `AgentSystem.close()` stops its agents and releases
the lock; the runtime intentionally contains no CAS or multi-owner coordination.

Storage uses Drizzle transactions and installs stdlib's universal `afterCommit` scope on their
contexts, draining it only after the outer transaction succeeds. Agent contexts expose the root or
active Drizzle facade as `ctx.db`; `ctx.inTx(work)` and the exported `inTx(ctx, work)` helper open
an outer transaction or reuse the one already carried by the context. Outside a transaction,
stdlib starts post-commit callbacks on the next microtask.

Storage, KV, migrations, and transactional module hooks compose with a context's outer transaction.
Live `Agent` and `AgentSystem` commands do not: creating, resolving, messaging,
mutating, archiving, or closing a live agent from inside an outer storage transaction is rejected
because the corresponding in-memory lifetime cannot be published until that transaction commits.

An agent runs in one of four permission modes — `read_only`, `workspace_write`, `auto`, and
`full_access` — carried on every context it derives and read back with `agentPermissionMode`. A
message changes it: `steer(ctx, message, { permissionMode })` takes effect when that message is
consumed, so a response and the tools it dispatched finish under the mode they started in. The mode
is durable, and a change is reported through `permissionModeChangedTransact` and
`permissionModeChanged`; every message entering the conversation is reported the same way through
`messageAcceptedTransact` and `messageAccepted`. The runtime enforces nothing — it cannot know what
a tool touches — so enforcement belongs to modules and tools; see the companion
[`@slopus/happy-agent-features`](../happy-agent-features) package.

A tool call is bracketed by four hooks and executed by the loop itself. `beforeToolCallTransact`
runs inside the transaction that makes a dispatched batch durable; `beforeToolCall` decides what
one validated call may do — leave it alone, run another tool, other arguments, or another
permission mode for that one execution, or answer the model directly so the tool never runs;
`afterToolCall` observes what the call produced; and `afterToolCallTransact` runs inside the
transaction that appends the result. Nothing outside the loop ever executes a tool: a hook that
drove execution would be deciding inside machinery that also commits results, resumes interrupted
batches, and settles cancelled ones.

Every executable call receives an internally generated cuid2 `id`, the provider's separate opaque
`providerCallId`, and a call-bound `kv`. Calling `call.commit(ctx, result)` inside a transaction
atomically saves that result with the tool's writes. The first successful commit wins; later
commits and the tool's eventual return or throw are ignored. Committed results survive a crash,
remain ordered with their batch, and the call-bound KV is erased in the result transaction.
Setting a tool's optional `transactional` property to `true` wraps its `execute` call, result
validation, rendering, and automatic result commit in one outer transaction. It defaults to
`false`.

Modules may provide an ordered array of `[key, migration]` tuples. Agent base tracks each
successful key and runs every missing migration transactionally before any `beforeStart` hook; a
failure aborts system startup. Every module migration and hook context carries the common Drizzle
facade in `ctx.db`: a root database outside a transaction and its active transaction facade inside
one. A migration also receives that facade explicitly to retain its exact engine-specific type.
Driver-only root members such as `$client` and `batch` are deliberately not part of that surface.
Modules may implement `beforeStart(ctx, agents)` and `afterStart(ctx, agents)` hooks.
Every `beforeStart` settles successfully before active agents are restored; every `afterStart`
runs after those agents are restored and started. Both receive the system's `AgentSystemRef`; their
context carries the root database.
All hooks may return synchronously or with a promise, including `onEvent`; the runtime awaits each
answer and contains failures from observing hooks.

Messages receive a generated cuid2 identity, or accept one through `{ id }` for idempotent
delivery. A repeated ID is an ignored persistence conflict while its message remains in the
durable conversation; deliberate conversation replacement releases identities for the records it
removes. `send` and `steer` return the effective ID, delivery mode, and whether durable acceptance
created the identity or found it already present. Optional immutable metadata travels beside the
provider message and reaches both message-accepted hooks; module-generated send and steer actions
accept the same fields.

Base allocates cuid2 identities for every settled-to-settled loop, turn, inference, and settlement.
The IDs are persisted with outstanding work before their first lifecycle hook, survive restart,
and are passed to transactional and observing hook counterparts without imposing a host protocol.
Modules may also observe agent creation, restoration, metadata changes, and archival. Creation,
restoration, and archival provide transactional and post-commit hook pairs with an immutable agent
ID/metadata snapshot and module-scoped shared KV.

Agent configuration may contain immutable metadata such as `title`. `updateMetadata` is available
from `AgentBase`, `Agent`, `AgentRef`, `AgentSystem`, and `AgentSystemRef`; updates shallow-merge,
commit before memory changes, and fire transactional and post-commit hooks. Created agents also
record a durable parent. An `AgentSystemRef` carries its owning agent ID (or `null`) and uses it as
the default parent, while creation options may override the parent or explicitly choose `null`.
`parentOf` and `childOf` query the resulting direct relationship, and `AgentRef.parent` exposes it.

`AgentKV.getOrCreate(ctx, key, factory)` standardizes durable allocate-once values. Used on a
tool's call-bound KV, it supplies retry-stable operation identities without heap state or provider
call IDs.

This package contains no ready-made product modules. Reusable tools, hooks, permissions,
workspaces, search, workflows, and other capabilities belong in
[`@slopus/happy-agent-features`](../happy-agent-features). Provider protocols and vendor
implementations belong in [`@slopus/happy-providers`](../happy-providers).

## Validation

```sh
pnpm --filter @slopus/happy-agent-base check
pnpm --filter @slopus/happy-agent-base test
pnpm --filter @slopus/happy-agent-base build
```
