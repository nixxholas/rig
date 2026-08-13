# Sources

This directory contains the public `@slopus/happy-agent-base` TypeScript source. The package entry
point is `index.ts`. `AgentBase` owns the durable event loop, while `Agent` composes independent
features around its hooks.

```text
feature tools/instructions ─┐
feature execution wrappers ├─> Agent ─> AgentBase ─> provider
feature lifecycle hooks ────┘                 │
                                             └─> durable transcript
```

`aroundToolExecution` is the provider-neutral correctness boundary for permissions and similar
policies. It runs only after JSON and TypeBox argument validation and immediately around the
tool's `execute`. Wrappers nest in feature order; repeated continuation calls share one
downstream execution.
