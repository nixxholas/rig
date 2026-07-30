# Server

This module owns the local daemon and its HTTP, WebSocket, and protocol
boundary. It authenticates local requests, starts and stops the daemon, exposes
protocol routes, streams protocol events, and manages the local socket, token,
logs, and diagnostics.

Domain behavior does not live here:

- `../session/` owns sessions and session stores.
- `../project/` owns projects and workspaces.
- `../git/` owns Git repository state and worktrees.
- `../global-event/` owns global-event queues and cursors.
- `../model-catalog/` owns the curated model catalog.
- `../file-search/` owns workspace file indexing and search.
- `../persistence/` owns every SQLite operation.

```text
main
 |
 v
runLocalProtocolServer
 |
 +-- local socket, token, logs, diagnostics
 +-- createProtocolHttpServer
 |    +-- HTTP routes and WebSocket terminals
 |    +-- session and global-event streaming
 +-- session / project / git / global-event domain modules
 +-- model-catalog / file-search services
 +-- Happy and MCP lifecycle services
```

The production files at this level are the server's public and operational
shape. HTTP-only helpers stay here with the route code. Tests live in
`tests/`.
