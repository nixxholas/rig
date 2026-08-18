# Happy Agent Client

This document specifies the public shape of `@slopus/happy-agent-client`: the one library a user
interface embeds to talk to a Happy agent daemon. It is designed against the HTTP contract in
[`packages/happy-agent/API.md`](../happy-agent/API.md) and it **replaces `rig-connect`** — both
rig-connect's live stores and the hand-rolled REST transports applications built beside it. It is
the successor to the library master plan `01-rig-connect.md` describes, and that plan's
guarantees — the element list, the group guarantee, optimistic mutations, reference stability —
govern this package.

## Two layers

The package has exactly two public layers, and both are part of its contract:

1. **The protocol API** — the existing `HappyAgentClient` class remains the stateless, typed
   client, with one flat method per endpoint. Each call is one HTTP request. Nothing is cached,
   nothing is retried, nothing runs in the background. This is the layer for scripts, tests,
   one-shot tools, and an application's non-UI processes.

2. **The live connection** — `connectHappyAgent(...)` returns a stateful connection built on the
   protocol API: one global event subscription, live stores a view subscribes to, and optimistic
   mutations delivered in the background. This is the layer applications render from.

An application uses both: the live connection for everything on screen, the protocol API for the
occasional imperative call (onboarding checks, a health probe, a file read for a picker).

## Principles

- **Plain Web APIs.** `fetch`, streams, `AbortController`, standard timers, Web Crypto. No Node
  built-ins, no platform branches. The package runs unchanged in Node, in a browser, and in any
  runtime providing those APIs.
- **One runtime contract.** Every JSON response and event has a TypeBox schema in
  `sources/protocol/`, one file per API chapter, and its TypeScript type is derived with
  `Static`. The protocol client validates at the network boundary. Schemas allow additional
  object fields so a compatible daemon may grow, while malformed known fields fail closed with
  a protocol error.
- **The transport is the caller's problem.** The daemon listens on a Unix socket; a browser
  reaches it through a proxy, a Node caller through a socket-capable `fetch` (an undici
  dispatcher). The client takes an `endpoint` URL, a `token`, and an optional `fetch` — it never
  dials a socket itself and never reads credentials from disk.
- **Honest failure.** Every daemon error surfaces as a typed error carrying the machine-readable
  `code`; every stream interruption is a state the subscriber can see; a lost event-journal
  cursor is a resync, not a silent gap.
- **Breaking with rig-connect is deliberate.** Names, shapes, and wire assumptions follow
  `API.md`, not the old protocol. What carries over from rig-connect is its obligations, not its
  types.

## Layer 1: the protocol API

```ts
const client = new HappyAgentClient({
    endpoint: "http://happy", // any authority; only path and query matter to the daemon
    token: "<bearer token>",
    fetch: socketFetch, // optional; defaults to globalThis.fetch
});
```

`HappyAgentClient` keeps its existing class name, constructor, and flat method naming. Resource
names in methods such as `getProject`, `createWorkspace`, and `sendMessage` already make the
surface unambiguous; adding namespaces would only force existing callers through a mechanical
migration. Parameters mirror endpoint inputs and return types come from `sources/protocol/`.

```ts
class HappyAgentClient {
    constructor(options: HappyAgentClientOptions);

    getHealth(options?: RequestOptions): Promise<HealthResponse>;
    listProjects(options?: RequestOptions): Promise<ProjectListResponse>;
    getProject(projectId: Cuid2, options?: RequestOptions): Promise<ProjectResponse>;
    listWorkspaces(
        query?: ListWorkspacesQuery,
        options?: RequestOptions,
    ): Promise<WorkspaceListResponse>;
    createWorkspace(
        request: CreateWorkspaceRequest,
        options?: RequestOptions,
    ): Promise<WorkspaceResponse>;
    sendMessage(
        agentId: Cuid2,
        request: SendMessageRequest,
        options?: RequestOptions,
    ): Promise<SendMessageResponse>;
    getMessages(
        agentId: Cuid2,
        query?: MessageHistoryQuery,
        options?: RequestOptions,
    ): Promise<MessageHistoryResponse>;
    getEvents(query?: EventPageQuery, options?: RequestOptions): Promise<EventPageResponse>;
    streamEvents(options?: EventStreamOptions): AsyncIterable<EventStreamFrame>;
    getDesktopBootstrap(options?: RequestOptions): Promise<DesktopBootstrapResponse>;
    // One flat method for every other request-response route in API.md.
}
```

Conventions across the whole layer:

- **Cancellation** — every function accepts an `AbortSignal`; the rejection is the signal's
  abort reason.
- **`If-Match`** — mutations the daemon guards take `VersionedRequestOptions` with a required
  `ifMatch`; the type system makes it impossible to forget the version.
- **`mutationId`** — request types carry the optional `mutationId` from the API basics; the
  protocol layer passes it through untouched. Minting and tracking IDs is layer 2's job.
- **Binary content** — avatars and the profile photo move as `ImageUpload` in and
  `BinaryContent` out, with `ETag`/`If-None-Match` handled through
  `ConditionalRequestOptions`; `null` means the daemon answered `304 Not Modified`, preserving
  the existing client contract.

### Errors

Every non-2xx response rejects with one error class:

```ts
class HappyAgentApiError extends Error {
    readonly status: number; // HTTP status
    readonly code: string | null; // stable snake_case string when the daemon supplied one
    readonly body: ApiErrorBody | null; // complete daemon error body, including documented extras
}
```

The existing `HappyAgentApiError` name and fields remain stable. Callers branch on `code` and
inspect `body` for endpoint-specific fields such as `currentVersion`, the current file `hash`,
or the replacement event cursor. Network-level failures are not wrapped; they propagate as the
underlying `fetch` rejection, which is how a caller tells "the daemon said no" from "the daemon
is unreachable".

### The event stream

`client.streamEvents(...)` is **one** SSE connection surfaced as an async iterable of
`EventStreamFrame`s — the `hello` frame first (with its honest `gap` flag), then events. When
the connection drops, the iterable ends; there is no hidden reconnect at this layer. Resuming,
backoff, and resync policy live in layer 2, where they can be implemented once and correctly.

### Named and deferred: the two non-HTTP surfaces

Terminal attachment (`.../terminals/:terminalId/attach`, a binary WebSocket) and the workspace
network proxy (`CONNECT .../proxy`) are part of the daemon's contract but not of this layer's
v1 surface: neither is expressible over `fetch`, and each needs a pluggable duplex-transport
story of its own. The flat names `attachTerminal(...)` and `proxyWorkspace(...)` are reserved
and will be designed when the first consumer lands. Until then,
applications keep their existing terminal bridge.

## Layer 2: the live connection

```ts
const connection = connectHappyAgent({
    endpoint,
    token,
    fetch: socketFetch,                        // optional, as in layer 1
    onCompatibilityChange: (c) => { ... },      // protocol handshake result, as it settles
    onMutationRejected: (rejection) => { ... }, // rejected optimistic actions, always delivered
    onAgentFinished: (finished) => { ... },     // an agent started waiting on the person
});
```

`HappyAgentConnection` owns exactly one event subscription through `client.streamEvents`,
resumed by cursor with exponential backoff, and every store below is fed from it. A `gap` in
the hello triggers a resync: the connection re-reads the REST snapshots behind its live
subscriptions and continues from the fresh cursor. Consumers never see the seam — only a
connection-state value that reports live, reconnecting, or resyncing.

All merging follows the API's version chain: a cached copy whose `version` equals an update's
`previousVersion` merges the changes; anything else marks the copy dirty and refetches that one
resource. Two copies of a resource always reconcile by comparing UUIDv7 versions.

### Subscriptions

Each subscription follows one shape: options carry callbacks, the returned handle carries
snapshot getters and `close()`. Snapshots are immutable; an unchanged entity keeps its object
identity across updates, so React consumers render from the snapshot and rely on referential
equality.

```ts
interface HappyAgentConnection {
    compatibility(): ServerCompatibility;
    state(): ConnectionState; // live | connecting | reconnecting | resyncing

    /** The whole catalog: projects, their workspace trees, and agent summaries. */
    catalog(options: CatalogSubscriptionOptions): CatalogSubscription;

    /** One agent's conversation: the element list plus the agent state. */
    conversation(options: ConversationSubscriptionOptions): ConversationSubscription;

    /** Live git state for a set of workspaces, registered with the daemon's watcher. */
    git(options: GitSubscriptionOptions): GitSubscription;

    /** Config, profile, and onboarding, refetched on their nudge events. */
    environment(options: EnvironmentSubscriptionOptions): EnvironmentSubscription;

    actions: HappyAgentActions; // the optimistic mutation surface, below
    client: HappyAgentClient; // layer 1, shared transport and token
    close(): void;
}
```

- **`catalog`** replaces rig-connect's `connectGroups`. It exposes projects in catalog order,
  each with its workspace tree (built from `parentId`), and each workspace with its active
  agents — title, status, unread, pending question, draft. It is fed by the `project.*`,
  `workspace.*`, `agent.*`, and `question.*` events and bootstraps from
  `client.getDesktopBootstrap()` plus project/workspace reads whose resources carry their own
  ordered top-level agents.
- **`conversation`** replaces `connectSession`; its state is specified in the next section.
- **`git`** wraps `POST /v0/git/watch` re-registration and the `git.updated` snapshots; the
  consumer names the workspace IDs it is looking at and receives whole-state replacements.
- **`environment`** watches `config.updated` and `profile.updated` and re-reads the
  corresponding endpoints, so settings screens are live without polling.

### The conversation state

The conversation store renders the API's runs and messages into the chat state master plan 01
defines: a flat, time-ordered list of elements, each carrying a stable element ID and a group
ID, with the group guarantee — every group ends with exactly one final element stating outcome,
reason, elapsed times, and cost.

The mapping from the wire model:

- **A group is a run.** The `runId` is the group ID. A user message's acceptance
  (`run.started` or `run.boundary` assigning its `runId`) is what stitches the pending composer
  state into its group; while pending, the message carries a provisional group ID (its own
  message ID) that the store replaces on acceptance without changing the element's own identity.
- **Elements are blocks.** One element per user message, per agent text block, per reasoning
  block, per tool call, per system or service notice. `message.delta` events grow the element
  in place; a tool call's `status`, `result`, and `presentation` land on the element that was
  already there. Presentations come from the daemon (`API.md`'s typed presentation set) — this
  package no longer computes them.
- **The group end is derived from explicit run facts.** The terminal run in `run.finished` or
  `run.boundary` produces the group's final element: `status` maps to outcome, `reason` is
  already one of completed, steering, abort, or error, and `startedAt`/`endedAt` provide elapsed
  time. `usage` and `costUsd` provide the run's final cost without querying agent-wide usage.
- **User steering is the only boundary.** `run.boundary` closes the old group, supplies the
  successor run, and names the accepted steering messages in oldest-first order. The store
  applies the footer, moves those messages from pending, opens the new group, and updates live
  activity in one snapshot. Incoming messages, notifications, and compaction remain in the
  current group.
- **Starting work is visible immediately.** `run.started` inserts the group's first, initially
  empty element and moves its `acceptedMessageIds` from pending into the group, so the UI shows
  that work began before the first model token without duplicating message content in the event.
- **History loads by runs.** Paging back maps to `GET .../messages?before=<runId>`; a page is
  whole runs, so groups never load half-finished. The store supports opening in the middle of a
  colossal history and extending in both directions.

Alongside the list, the subscription reports the **agent state**: the full activity phase
(idle, thinking, working, generating tools, running tools — never collapsed to a boolean),
the pending question, running process and subagent counts, `lastMode` for composer prefill,
the draft, and unread. It is fed by `agent.updated` and settles to reality on every reconnect
and resync, so a dead run can never leave the UI claiming work is in progress.

### Actions

Every mutation an interface performs goes through `connection.actions`, and every one of them
is optimistic, exactly as plan 01 dictates: the local state reflects the action the instant it
is taken, the request travels in the background with backoff, ordering is held per entity, and
the daemon's echo is recognized by `mutationId` rather than applied twice.

```ts
interface HappyAgentActions {
    // Agents and conversation
    createAgent(input: CreateAgentInput): Cuid2; // returns the client-minted agent ID
    send(agentId: Cuid2, input: SendInput): Cuid2; // returns the client-minted message ID
    abort(agentId: Cuid2, expectedRunId?: Cuid2): void;
    compact(agentId: Cuid2): void;
    answerQuestion(agentId: Cuid2, questionId: Cuid2, answers: QuestionAnswers): void;
    saveDraft(agentId: Cuid2, draft: AgentDraft | null): void;
    markRead(agentId: Cuid2): void;
    archiveAgent(agentId: Cuid2): void;
    unarchiveAgent(agentId: Cuid2): void;
    reorderAgent(agentId: Cuid2, afterId: Cuid2 | null): void;
    stopProcess(agentId: Cuid2, processId: Cuid2): void;

    // Projects and workspaces
    registerProject(input: RegisterProjectInput): Cuid2;
    cloneProject(input: CloneProjectInput): Cuid2;
    renameProject(projectId: Cuid2, name: string): void;
    archiveProject(projectId: Cuid2): void;
    reorderProject(projectId: Cuid2, afterId: Cuid2 | null): void;
    createWorkspace(input: CreateWorkspaceInput): Cuid2; // returns the client-minted workspace ID
    renameWorkspace(workspaceId: Cuid2, name: string): void;
    archiveWorkspace(workspaceId: Cuid2): void;
    reorderWorkspace(workspaceId: Cuid2, afterId: Cuid2 | null): void;
}
```

Two contracts here are load-bearing for applications and are guarantees of this package:

- **Client-named identity.** Creation actions mint the real CUID2 locally and return it
  synchronously — the API accepts client-supplied IDs precisely for this. An application
  navigates to the workspace or agent it just created immediately; the daemon's row and the
  optimistic row are one entity from the first frame, across refresh and reconnect. This
  replaces rig-connect's "mutation ID as provisional entity ID" trick with real identities,
  which is strictly simpler for consumers.
- **Nothing disappears quietly.** A prediction the daemon corrects is corrected on screen
  through the normal merge. A mutation that cannot be delivered at all is reverted and reported
  through `onMutationRejected` — always delivered, whether or not a view is subscribed to the
  entity. First-write-wins conflicts (a question answered elsewhere first) resolve by rendering
  the authoritative outcome.

Answering a question, aborting, and `If-Match`-guarded mutations carry their guards from the
store's own cached versions; the consumer never handles a version by hand at this layer.

## What this replaces in the applications

For happy-desktop, this package supersedes two parallel stacks at once:

- `@slopus/rig-connect` — the nine `rigConnect*Source.ts` adapters re-point at the
  subscriptions above; `rigConnection.ts` constructs `connectHappyAgent` instead of
  `connectRig`.
- The hand-rolled REST/SSE path — `rigTransport.ts`, `rigRendererTransport.ts`,
  `rigProxyHandle.ts`'s REST projection, and `rigDaemonClient.ts` collapse into layer 1 plus a
  thin socket-`fetch` in the Electron main process. The dual optimistic/awaited branches in the
  chat and list stores become a single path through `connection.actions`.

The transcript rendering keeps its element-list shape, so `rigConnectConversationProject.ts`
adapts rather than restarts; the element and presentation vocabularies do change to this
package's API-derived ones, and that rework is accepted as part of the replacement.

## Out of scope, by name

These rig-connect surfaces have no counterpart in `API.md` today. They are deliberately absent
from this design rather than forgotten, and each returns as a client surface only when the API
grows the corresponding chapter: folders and the virtual tree, documents, a cross-agent inbox
surface (derivable meanwhile from catalog `pendingQuestionId` badges), sharing and Murmur, P2P
pairing and multi-daemon addressing (a connection targets one endpoint; an application with many
daemons holds many connections), multiple human profiles, provider plan quota, secrets, slots
and applets, scheduled messages, goals, and workflow runs.

Plugins, worklets, timeline, Happy Cloud, remote terminal groups, and rig-connect's exported
presentation helpers are dropped without replacement; no application uses them.
