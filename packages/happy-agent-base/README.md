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
