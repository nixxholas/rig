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

- resolves one Happy root (default `~/.happy`) before any subsystem starts;
- derives the private `<happyHome>/agent` and sibling public `<parent>/Happy` homes;
- loads global `Happy/Config/happy.toml`, project `rig.toml` (or `happy.toml`) from the current
  directory, and `<happyHome>/agent/runtime.toml`, with runtime values overriding project and
  global values;
- opens the authenticated Unix socket first, reporting `status: "starting"` until the Agent
  System is ready;
- opens `<happyHome>/agent/agent.sqlite` through asynchronous libSQL and takes an exclusive process
  lock;
- creates a host compute rooted at the derived public home;
- installs every standard module and runs its migrations;
- restores or creates the home’s stable root agent;
- listens on a mode-`0600` Unix socket, normally `<happyHome>/agent/server.sock`;
- closes HTTP, the agent system, compute, lock, and database together.

```ts
import { createRootContext } from "@steve.kite/stdlib";
import { startHappyAgentDaemon } from "@slopus/happy-agent";

const daemon = await startHappyAgentDaemon(createRootContext(), {
    happyHome: "~/.happy",
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

The resolved `daemon.configuration.paths` is the authoritative immutable layout. A custom
`<parent>/.happy` always uses `<parent>/Happy` as its public home; callers do not provide
`agentHome`, `publicHome`, socket, token, or database paths separately. Unknown TOML settings are
ignored and listed on the corresponding configuration source; malformed TOML and invalid known
values fail startup.

The lower-level `loadHappyAgent(ctx, options)` remains available when a host wants the standard
agent lifetime without the HTTP daemon; its `configuration` field accepts the same resolved
configuration object.

## Unix-socket API

Every endpoint is under `/v0`. Happy Agent speaks Rig protocol version 17 directly, so the existing
`rig-connect` client can consume its catalog, sessions, transcript windows, and live updates
without a connector-specific compatibility path. Capabilities explicitly excluded from this daemon
remain unsupported.

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
- `GET /v0/events` — bounded durable event replay.
- `GET /v0/events/live` — live Server-Sent Events with replay and `Last-Event-ID`.
- `GET /v0/events/stream` — durable global SSE replay.
- `GET /v0/catalog` — a Rig-shaped catalog snapshot.
- `GET /v0/folders`, `/v0/plugins`, `/v0/worklets`, `/v0/profiles`, `/v0/sharing`,
  `/v0/provider-usage`, `/v0/secrets`, and `/v0/external-tool-calls` — protocol-valid empty or
  unavailable snapshots for optional Rig views that Happy Agent does not host yet.
- `PUT|DELETE /v0/sessions/:sessionId/terminal-connections/:connectionId` — no-op terminal
  presence acknowledgements so an existing Rig client can open and close a Happy Agent chat.
- `POST /v0/timeline` — global timeline snapshot; project/workspace/session timelines are not
  claimed unless their host is configured.
- `GET|POST /v0/sessions...` — conversation creation, listing, messages, state, transcript, and
  module actions.
- `GET|POST|PATCH /v0/projects...` — local project/workspace/file/Git routes. Remote cloning,
  Docker workspaces, and other excluded host capabilities return an explicit unsupported response.
- `POST /v0/shutdown` — close the daemon started by `startHappyAgentDaemon`.

Compatibility reads do not claim unavailable capabilities. Their mutation routes remain
unsupported instead of reporting fake success.

Message bodies accept either a string or text/image input blocks. The same request may select the
provider, model, reasoning effort, service tier, and permission mode. An optional caller-generated
cuid2 makes delivery idempotent.

The Events module observes Agent Base directly and assigns every update a durable UUIDv7 that stays
strictly ordered across restarts and clock rollback. Current provider `SessionEvent` values,
including reasoning, text, tool-call/result, retry, usage, reset, and completion updates, are
retained verbatim. Rig sessions also receive an explicit indexed UI projection beside the native
event; the projection never replaces or casts away provider data.

SSE frames use the durable UUID as `id`, the update type as `event`, and the complete event envelope
as JSON `data`. Reconnect with `Last-Event-ID` or `?after=`. The Rig-compatible global stream
reports an expired bounded cursor as `gap: true` in its hello so `rig-connect` reloads the catalog;
the lower-level durable stream still reports a missing cursor as a conflict. Both global and session streams
queue whole frames, stop writing until Node emits `drain`, cap pending and writable bytes, skip
heartbeats under pressure, and disconnect slow consumers so they can replay from their last
successfully applied cursor.

If the daemon dies mid-inference, Agent Base restores its durable owed stage. Happy Agent restores
the matching run identity, emits `block_reset` for the abandoned partial block, and continues the
same run without presenting the partial text as completed history.

`@slopus/happy-agent` does not add a second agent runtime. `AgentStorage` and
`AgentSystemLocal` from Agent Base remain the owners.
