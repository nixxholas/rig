# @slopus/happy-agent-base

The minimal core of a Happy coding agent.

`AgentBase` is one agent session over one `@slopus/happy-providers` provider. Messages arrive
through two FIFO queues — steering and send — the loop replays the full conversation to the
provider session, and the streamed events are forwarded to the optional hooks while the
assistant reply joins the history. When the model stops for tool calls, the agent executes them
and feeds the results back. The conversation is observable only through hooks; there is no
external transcript or status surface.

## Core API

```ts
class AgentBase {
    constructor(ctx: Context, options: AgentBaseOptions);

    readonly id: string;
    readonly state: AgentBaseState; // the agent's own copy, mutable directly

    steer(ctx: Context, message: SessionUserMessage, options?: AgentBaseMessageOptions): Promise<void>;
    send(ctx: Context, message: SessionUserMessage, options?: AgentBaseMessageOptions): Promise<void>;
    start(): void;
    abort(): Promise<void>;
    compact(ctx: Context): Promise<void>;
    waitForIdle(): Promise<void>;
    close(): Promise<void>;
}

interface AgentBaseOptions {
    id: string;
    providers: AgentProviders;
    provider: string; // registry ID; serializable alongside model and effort
    persistence: AgentBasePersistence;
    hooks?: AgentBaseHooks;
    initialState?: Partial<AgentBaseState>; // copied into the agent's own state
    model?: string;
    effort?: SessionReasoningEffort;
    serviceTier?: SessionServiceTier;
    steeringMode?: "one-at-a-time" | "all"; // default "one-at-a-time"
    sendMode?: "one-at-a-time" | "all"; // default "one-at-a-time"
}

interface AgentBaseState {
    instructions: string;
    tools: AnyAgentTool[];
}

interface AgentBaseHooks {
    onEvent?: (ctx: Context, event: SessionEvent) => void;
    instructions?: (ctx: Context) => string;
    tools?: (ctx: Context) => readonly AnyAgentTool[];
    modelChanged?: (ctx: Context, change: AgentBaseModelChange) => SessionSystemMessage | undefined;
    beforeAgentLoop?: (ctx: Context) => void;
    beforeTurn?: (ctx: Context) => void;
    beforeInference?: (ctx: Context) => void;
    afterInference?: (ctx: Context) => void;
    afterTurn?: (ctx: Context) => readonly AgentFeatureAction[] | undefined;
    afterAgentLoop?: (ctx: Context) => readonly AgentFeatureAction[] | undefined;
}

interface AgentBaseModelChange {
    previousModel: string | undefined;
    model: string;
    previousProvider: string;
    provider: string;
    providers: AgentProviders;
    previousProviderInstance: BaseProvider | null;
    providerInstance: BaseProvider | null;
    wasReset: boolean; // the change was incompatible and the history was erased
}

interface AgentBaseMessageOptions {
    provider?: string; // registry ID to switch to
    model?: string;
    effort?: SessionReasoningEffort;
    serviceTier?: SessionServiceTier;
}

type AgentFeatureAction =
    | { type: "steer"; message: SessionUserMessage }
    | { type: "send"; message: SessionUserMessage }
    | { type: "compact" };

interface AgentTool<Args extends TSchema = TSchema, Result extends TSchema = TSchema> {
    // The provider-facing descriptor fields of SessionTool, with parameters typed as Args, plus:
    durable?: boolean;
    returnType: Result;
    execute(ctx: Context, args: Static<Args>): Promise<Static<Result>>;
    toLLM(result: Static<Result>): readonly SessionOutputBlock[];
    isError?(result: Static<Result>): boolean;
}

function defineAgentTool<const Args extends TSchema, const Result extends TSchema>(
    tool: AgentTool<Args, Result>,
): AgentTool<Args, Result>;

interface AgentBasePersistence {
    transaction<Result>(ctx: Context, work: (ctx: Context) => Promise<Result>): Promise<Result>;
    load(ctx: Context): Promise<readonly AgentBaseRecord[]>;
    append(ctx: Context, record: AgentBaseRecord): Promise<void>;
    clearRecords(ctx: Context): Promise<void>; // physical delete, used inside the compaction transaction
    readValues(ctx: Context, prefix: string): Promise<readonly { key: string; value: unknown }[]>;
    writeValue(ctx: Context, key: string, value: unknown): Promise<void>;
    deleteValue(ctx: Context, key: string): Promise<void>;
}
```

Persistence is an append-only main context store plus a sorted key-value store alongside it. The
agent serializes every operation through one internal lock (configured to crash on re-entry), so
implementations never see concurrent calls and need no locking of their own.

A queued message is written under a `steering.` or `send.` key ordered by append time;
nothing that is not yet part of the context reaches the main store. When a queue drains, each
consumed message is appended as a user record and its queue key deleted, all inside one
`transaction` so a crash or failure can never leave a message in both stores or neither, and
only then does inference run on the resulting context. Transactions are completely transparent
to the agent: the implementation opens one, hands work a derived context its own operations
recognize, and carries the transaction on that context however it likes; work resolving
commits, a thrown error rolls back. Assistant output is appended one finished block at a time as
it streams, so main-store records always arrive in context order and consecutive block records
reassemble into one assistant message on load. The agent loop loads everything once, on the first
inference attempt; the load result replaces the in-memory state, including leftover queued
messages from an earlier process, which join the next turn. A failed load is reported as an
`internal_error` done event and is not sticky: the next requested turn retries it, with every
queued message still safely waiting.

The two queues give four delivery strategies, mirroring Pi:

| Strategy | Behavior |
|---|---|
| Steering + one-at-a-time | `steer` queues FIFO. After the current assistant response and all its tool calls finish, the oldest message injects, gets a response, then the next is handled. |
| Steering + all | After the current response and tool batch finish, every queued steering message injects together before one response. |
| Send + one-at-a-time | `send` waits until the agent would otherwise stop — no tool calls or steering remain — then injects one message and waits for its response before draining another. |
| Send + all | Once the agent would otherwise stop, every queued sent message injects together before one response. |

Both modes default to `"one-at-a-time"`, and steering always takes precedence over sent messages.
Queue consumption happens only between inferences — never mid-stream and never during a tool
batch — so an injected message can never interleave with an active response's block records.

`steer` and `send` resolve once the durable queue write lands, so a failed write keeps the
message out of the conversation; they wait neither for the history load nor for the turn. Each
message may carry its own inference settings — provider, model, effort, and service tier —
which take effect when the message is consumed and stay effective for every later message that does not
override them, surviving restarts through a durable settings entry. A message without settings
uses the previously effective values, or the constructor defaults when nothing was ever carried;
relying on those defaults is discouraged — prefer sending settings with the message.

A provider or model change is checked against the provider-model compatibility matrix from
`@slopus/happy-providers`, using the compatibility types the providers were registered with. A
compatible change keeps the conversation; a compatible provider change still gets a fresh
session on the new provider, since a session is bound to the provider that created it. An
incompatible change — including a switch to a different provider of the same type, or to an
unregistered ID — resets the conversation: the durable history is erased completely, the old
provider session is destroyed, and a fresh session serves the new selection. The `modelChanged`
hook fires on every selection change with the old and new model, both provider IDs and live
instances, the registry, and the `wasReset` flag; on a reset the handoff system message it
returns is injected at the very beginning of the fresh context — without one the context starts
completely empty. The consumed message that carried the new selection follows the handoff. A
thrown provider or load failure is reported to the `onEvent` hook as an `internal_error` done
event instead of rejecting the loop. The agent never retries inference itself — providers own
retry semantics and surface them as `retrying` events. A provider-reported error response ends
that response but not the turn: messages still queued drain into a fresh inference, each drain
consuming from a finite queue, so a persistently failing provider cannot loop.

A turn that ends failed surfaces its error to the context as a durable system message
(`The last turn failed: <message>`), so the next inference sees what went wrong. Only
unrecovered failures leave this trace: a provider-reported error followed by a successful
response in the same turn recovers silently, and a failed history load appends nothing since
there is no loaded context to append to.

When a turn stops for tool calls, every call in the batch runs in parallel. Arguments are
validated against the tool's TypeBox `parameters` schema before `execute` runs, so `execute`
receives them as `Static<Args>` rather than unknown. `execute` returns a structured result that
is validated against `returnType` and then rendered into output blocks for the model with
`toLLM`; an optional `isError` predicate marks a structured result as an error. A missing tool,
invalid JSON arguments, arguments that fail the schema, an incomplete call, a thrown `execute`,
or a result that fails `returnType` becomes an error tool result
(`isError: true`) for the model instead of failing the run; provider-settled server calls are
never executed by the agent, and their streamed `toolcall_result_*` events are simply ignored —
the server call block stays in the history, the events reach the hooks, and no tool result
message is stored or owed.

Before any call in a batch executes, the whole batch is committed to the sorted store under
`tool.` keys ordered by position, so a crash mid-batch leaves a durable record of the calls still
owed a result. Calls run in parallel, but results land strictly in call order: a finished result
waits until every earlier call in the batch has committed, and each commit appends the `tool`
record and deletes the pending entry in one transaction. Once the batch is complete the loop runs
inference again with the full context.

`start` begins the loop without a new message: it loads the durable state and continues a turn
that was cut off by a crash — leftover queued messages are consumed, a dispatched `tool.`
batch is settled, and an unanswered user or tool message gets its inference. When an interrupted
batch resumes, only tools marked `durable: true` execute again; every other interrupted call
becomes an error tool result, since the agent cannot know whether its side effects already
happened. On an idle history `start` loads and does nothing more.

`compact` compacts the conversation through the provider session. It waits for the active turn
to end — including queued messages already draining — or runs right away when idle, snapshots
the history, and asks the provider to compact it. The completed replacement context supersedes
the compacted history while any message that joined after the snapshot is kept. In one atomic
transaction the superseded records are physically deleted and the replacement — the messages
that stay — is appended as a `compaction` record, which then opens the store while later
records append as usual. Calls made while a compaction is pending or running
await that same shared compaction; it resolves on completion and rejects when the provider
reports failure, leaving the history untouched.

Hooks receive the agent's context first. That context — shared by tool executions — is derived
once at construction and carries the agent's provider registry ID, model, effort, and
service tier — all serializable values — readable through the exported `agentBaseProvider`,
`agentBaseModel`, `agentBaseEffort`, and `agentBaseServiceTier` accessors. The
`instructions` and `tools` hooks, when provided, answer for the session: they are consulted for
session creation, every inference request, compaction, and tool lookup, superseding
`state.instructions` and `state.tools`. A hook that throws falls back to the state and never
fails the run.

The lifecycle hooks bracket the loop's own structure. `beforeAgentLoop` fires when the loop
leaves the settled state and begins working, and `afterAgentLoop` fires when it would settle
back to idle; between them, each turn is bracketed by `beforeTurn` and `afterTurn`, and each
inference request inside a turn by `beforeInference` and `afterInference`. `afterTurn` and
`afterAgentLoop` may return an array of `AgentFeatureAction`s, all applied together before the
loop continues: `steer` and `send` queue a message through the ordinary durable queues exactly
as the public methods do, and `compact` triggers the shared compaction. Actions from `afterTurn`
drive the loop into another turn within the same loop span; actions from `afterAgentLoop` reopen
the loop instead of settling. Like every hook, a thrown lifecycle hook — or a failing action —
never fails the run.

`abort` cancels the active turn and resolves once the loop has stopped; when idle it is a no-op.
The inference stream is abandoned and asked to close, a `done` event with state `cancelled` is
emitted, blocks that already finished stay in the history while an unfinished block is dropped
everywhere, and each still-running tool call settles as an error tool result saying it was
aborted — consuming its pending `tool.` entry so the batch leaves a complete context behind.
The queued turn request is dropped too, but messages still waiting in the steering and
send queues stay durable and join the next requested turn.

`AgentProviders` is a mutable registry of provider instances keyed by caller-supplied IDs, so the
same provider class can be registered under several IDs. `add(id, provider, type)` registers an
instance together with its compatibility type (`"claude"`, `"codex"`, `"grok"`, `"bedrock"`, or
`"gym"`), `get(id)` returns the provider or null, and `typeOf(id)` returns the registered type
or null. The agent is configured entirely with serializable values — a
provider registry ID, a model name, an effort level, and a service tier — and resolves the live provider from
the registry when the session is first created; an ID that is not registered at that moment
fails the turn like any thrown error.

## Validation

```sh
pnpm --filter @slopus/happy-agent-base check
pnpm --filter @slopus/happy-agent-base test
pnpm --filter @slopus/happy-agent-base build
```
