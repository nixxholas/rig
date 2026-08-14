# @slopus/happy-agent-base

The minimal durable runtime for Happy agents.

`AgentBase` owns one agent's persistent inference and tool loop. It durably queues messages,
streams provider responses, executes tools, compacts history, resumes interrupted work, and
keeps inference, tool results, and settlement transactionally consistent across process
restarts.

The package also provides the primitives needed to host that runtime:

- `Agent`, `AgentSystem`, and `AgentSystemLocal` for composing and addressing agents;
- `AgentPersistence`, `AgentStorage`, and `AgentKV` for durable state;
- `AgentProviders` for resolving provider/model routes;
- `AgentTool` and lifecycle hooks for extending the loop.

One `AgentSystem` exclusively owns one durable store. Every `AgentStorage` adapter must acquire a
hard database-level lock before the system starts; `AgentSystem.close()` stops its agents and
releases that lock. The runtime intentionally contains no CAS or multi-owner coordination.

An agent runs in one of four permission modes — `read_only`, `workspace_write`, `auto`, and
`full_access` — carried on every context it derives and read back with `agentPermissionMode`. A
message changes it: `steer(ctx, message, { permissionMode })` takes effect when that message is
consumed, so a response and the tools it dispatched finish under the mode they started in. The mode
is durable, and a change is reported through `permissionModeChangedTransact` and
`permissionModeChanged`; every message entering the conversation is reported the same way through
`messageAcceptedTransact` and `messageAccepted`. The runtime enforces nothing — it cannot know what
a tool touches — so enforcement belongs to features and tools; see `PermissionsFeature` in
[`@slopus/happy-agent-features`](../happy-agent-features).

A tool call is bracketed by four hooks and executed by the loop itself. `beforeToolCallTransact`
runs inside the transaction that makes a dispatched batch durable; `beforeToolCall` decides what
one validated call may do — leave it alone, run another tool, other arguments, or another
permission mode for that one execution, or answer the model directly so the tool never runs;
`afterToolCall` observes what the call produced; and `afterToolCallTransact` runs inside the
transaction that appends the result. Nothing outside the loop ever executes a tool: a hook that
drove execution would be deciding inside machinery that also commits results, resumes interrupted
batches, and settles cancelled ones.

Features may implement async `beforeStart(ctx, agents)` and `afterStart(ctx, agents)` hooks.
Every `beforeStart` settles successfully before active agents are restored; every `afterStart`
runs after those agents are restored and started. Both receive the system's `AgentSystemRef`.

This package contains no ready-made product features. Reusable tools, hooks, permissions,
workspaces, search, workflows, and other capabilities belong in
[`@slopus/happy-agent-features`](../happy-agent-features). Provider protocols and vendor
implementations belong in [`@slopus/happy-providers`](../happy-providers).

## Validation

```sh
pnpm --filter @slopus/happy-agent-base check
pnpm --filter @slopus/happy-agent-base test
pnpm --filter @slopus/happy-agent-base build
```
