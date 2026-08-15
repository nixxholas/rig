# `@slopus/happy-agent`

The complete public API for building a Happy agent.

This package combines:

- `@slopus/happy-agent-base` for the agent runtime, storage, providers, and lifecycle;
- `@slopus/happy-agent-modules` for reusable agent capabilities;
- `@slopus/happy-agent-compute` for host, Docker, and emulated compute backends.

Agent Base and the modules are re-exported directly. Compute is exported as the `compute`
namespace so its backend constructors remain clearly separated from agent behavior:

```ts
import { AgentStorage, AgentSystemLocal, HistoryModule, compute } from "@slopus/happy-agent";

const machine = compute.createHostCompute({ ctx, cwd });
```

## Starting the daemon

`startHappyAgentDaemon` is the top-level composition root. It:

- creates the private home and public home;
- opens `<agentHome>/agent.sqlite` through asynchronous libSQL and takes an exclusive process
  lock;
- creates a host compute rooted at `publicHome`;
- installs every standard module and runs its migrations;
- restores or creates the home’s stable root agent;
- listens on a mode-`0600` Unix socket, normally `<agentHome>/server.sock`;
- closes HTTP, the agent system, compute, lock, and database together.

```ts
import { createRootContext } from "@steve.kite/stdlib";
import { startHappyAgentDaemon } from "@slopus/happy-agent";

const daemon = await startHappyAgentDaemon(createRootContext(), {
    agentHome: "~/.happy/agent",
    publicHome: "~/Happy",
    providers,
    provider: "codex",
    models,
    integrations,
});

console.log(daemon.socketPath);
await daemon.close();
```

Folders provide storage, compute, AGENTS.md, skills, applets, worklets, and generated media.
Capabilities that reach another service remain explicit in `integrations`: collaboration, Happy,
MCP, search, image generation, scheduling, user input, workflow/worklet runtimes, and slot
projection.

The lower-level `loadHappyAgent(ctx, options)` remains available when a host wants the standard
agent lifetime without the HTTP daemon.

## Unix-socket API

Every endpoint is under `/v0`; it is intentionally a new API rather than a Rig compatibility
surface.

- `GET /v0/health` — readiness, model catalog, and daemon identity.
- `GET /v0/agent` — root agent metadata, active state, installed modules, and event cursor.
- `GET /v0/installation` — persistent installation epoch and schema version.
- `GET /v0/models` — the curated provider/model catalog.
- `GET|PATCH /v0/config` — daemon settings (runtime changes are rejected unless a host supplies them).
- `GET|PUT /v0/config/instructions` — the bounded global `AGENTS.md` document.
- `GET|PUT /v0/config/security` — the bounded global `AGENTS_SECURITY.md` document.
- `POST /v0/messages` — queue a normal user message.
- `POST /v0/steering` — queue a message for the current turn boundary.
- `POST /v0/abort` — cancel the active turn.
- `POST /v0/compact` — compact the conversation.
- `PATCH /v0/agent/metadata` — shallow-merge agent metadata.
- `GET /v0/events` — bounded in-memory event replay.
- `GET /v0/events/live` — live Server-Sent Events with replay and `Last-Event-ID`.
- `GET /v0/events/stream` — durable-shaped SSE alias for the same process-local journal.
- `GET /v0/catalog` — a Rig-shaped catalog snapshot.
- `POST /v0/timeline` — global timeline snapshot; project/workspace/session timelines are not
  claimed unless their host is configured.
- `GET|POST /v0/sessions...` — conversation creation, listing, messages, state, transcript, and
  module actions.
- `GET|POST|PATCH /v0/projects...` — local project/workspace/file/Git routes. Remote cloning,
  Docker workspaces, and other excluded host capabilities return an explicit unsupported response.
- `POST /v0/shutdown` — close the daemon started by `startHappyAgentDaemon`.

Message bodies accept either a string or text/image input blocks. The same request may select the
provider, model, reasoning effort, service tier, and permission mode. An optional caller-generated
cuid2 makes delivery idempotent.

The Events module observes Agent Base directly and assigns every update a process-monotonic
UUIDv7. SSE frames use that UUID as `id`, the update type as `event`, and the complete event
envelope as JSON `data`. Reconnect with `Last-Event-ID` or `?after=`. A client with an expired
bounded cursor receives `409 Event cursor not found` and should reload `/v0/agent`; a new client
starts at the current cursor instead of replaying history it did not request. Connections receive
15-second comment heartbeats and are closed on backpressure so they can safely reconnect.

`@slopus/happy-agent` does not add a second agent runtime. `AgentStorage` and
`AgentSystemLocal` from Agent Base remain the owners.
