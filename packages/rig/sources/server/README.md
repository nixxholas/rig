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

`POST /projects` is the project-registration boundary. Its strict body is
`{ path, projectId? }`; it returns the same authoritative `Project` entity as
the catalog and maps project-domain path failures to stable, displayable codes.
It never creates a session or workspace.

Fatal daemon failures are observed before the CLI exit handler runs. The daemon
writes the original stack to its structured log and synchronously creates a
compact Node diagnostic report with JavaScript and native stacks. Reports are
written only when the runtime can exclude environment credentials and are
pruned by `prepareDaemonDiagnostics.ts`. The directory is mode `0700`;
uncaught-exception reports are additionally forced to `0600`. An inability to
write the report is recorded without hiding the original failure.
