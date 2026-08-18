# Runtime

This directory owns the complete local Happy agent runtime: configuration, databases, exclusive
storage locks, module composition, the agent system, background lifetimes, and orderly shutdown.
The executable package only binds transport and asks this runtime to start.

```text
Config ──> Observation ──> databases + locks
   │                            │
   └────────> domain modules ───┤
                                v
                        AgentSystemLocal
                                │
                                v
                         API + Happy sync
```

`ApiModule` is placed first in module startup order. It can subscribe to every producer before any
later module restores agents or emits startup events. Migrations still run through the single Agent
Base migration pass.

The main and automatic-review stores are separate databases with separate process locks. Runtime
shutdown stops new background work, waits for admitted tasks, and closes resources in reverse
ownership order.
