# agent/impl

Secondary functions used to implement the agent, its inference loop, and its
public convenience exports. The primary module shape stays at the agent root:
`Agent`, `loop`, shared message and tool types, and presentation contracts.

Each implementation file owns one focused helper. Focused helper tests live in
`impl/tests`; broader agent and loop behavior lives in the root `tests`
directory. Each feature area keeps its tests in its own `tests` directory.

Feature areas with their own vocabulary and structure remain separate sibling
modules: `compaction`, `context`, `prompt`, `skills`, and `tools`.
