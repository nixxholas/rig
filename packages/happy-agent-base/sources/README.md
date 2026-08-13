# Source layout

`AgentBase` is the durable inference and tool runtime. `Agent` composes its extension hooks,
`AgentSystemLocal` owns agent lifetimes, and the storage types define the persistence boundary.
`AgentStorage` requires the host's hard single-owner database lock.

No ready-made capabilities live in this package. They belong in `@slopus/happy-agent-features`.
