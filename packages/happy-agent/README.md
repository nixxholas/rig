# `@slopus/happy-agent`

The executable shell around the Happy Agent runtime.

All agent behavior lives in `@slopus/happy-agent-modules`: configuration, databases, storage
locks, module composition, events, HTTP routing, Happy synchronization, files, Git, terminals, and
the Agent System itself. This package owns only the daemon process boundary:

- start the modules-owned runtime;
- bind its API to the configured Unix domain socket;
- forward HTTP, WebSocket upgrades, and `CONNECT` tunnels to the API module;
- secure and remove the socket;
- stop the socket and runtime cleanly.

```ts
import { startHappyAgentDaemon } from "@slopus/happy-agent";

const daemon = await startHappyAgentDaemon({ happyHome: "/path/to/.happy" });
console.log(daemon.socketPath);
await daemon.close();
```

The runtime exposes starting health before Agent System restoration completes. Every request,
including health, uses the bearer token persisted at `daemon.tokenPath`. The socket and token are
owner-only.

Use `@slopus/happy-agent-client` to call the API. The complete HTTP contract is specified in
[`API.md`](API.md).
