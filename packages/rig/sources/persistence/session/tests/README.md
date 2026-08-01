# Session persistence tests

These tests exercise the public consistency boundaries in the parent session persistence module.
They use an isolated SQLite database and observe durable results rather than implementation
helpers.

```text
test fixture --> persistence operation --> SQLite
      ^                                  |
      +----------- durable result -------+
```

`queryAgentTreeUsage.test.ts` covers recursive durable usage across hidden and
visible delegation links, including completed and zero-usage sessions, cycles,
mixed deep trees, subtree callers, invalid dual links, deterministic ordering,
and the exact 10,000-session bound. `AgentTreeUsage.integration.test.ts` exercises
the real session-manager context through both session stores, including reset,
workspace delegation, completed nested subagents, tool execution, and restart.
