# Tests

Tests here use temporary, user-shaped plugin folders. They keep manifest discovery, TypeScript
compatibility, authenticated API calls, process cleanup, and log retention deterministic without
depending on a real home directory.

`pluginLifecycle.test.ts` supplies its own starter through `PluginManager`'s `start` option. The
real one spawns a sandboxed process, which cannot nest inside the sandbox this suite may already
run in, and the manager's contract under test is registration, stopping, and the events it
publishes. Spawning a real plugin is covered by the gym instead.

`PluginMcpRegistry.test.ts` covers live registration identity, forwarding, concurrency,
cancellation, timeout, permissions, restart, and stale-completion contracts.
`PluginNetworkRegistry.test.ts` covers deterministic first-folder handling and observation-only
delivery to later matching plugins.
