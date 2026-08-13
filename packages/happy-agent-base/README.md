# @slopus/happy-agent-base

The minimal core of a Happy coding agent.

`AgentBase` is one agent session over one `@slopus/happy-providers` provider. Messages arrive
through two FIFO queues — steering and send — the loop replays the full conversation to the
provider session, and the streamed events are forwarded to the optional hooks while the
assistant reply joins the history. When the model stops for tool calls, the agent executes them
and feeds the results back. The conversation is observable only through hooks; there is no
external transcript or status surface.

## Prepared host features

The package also exports isolated `execution`, `git`, `workspaces`, `permissions`, `user-input`,
`image-generation`, `search`, `secrets`, and `workflows` features. Each directory owns its tool
array, agent hooks, direct public API, TypeBox boundary schemas, injected host ports, and focused
tests. The features do not import one another; an application composes their ports at its own
boundary.

These features are additive migration preparation. They do not switch Rig to this package or
remove `rig-execution`.

## Core API

```ts
class AgentBase {
    constructor(ctx: Context, options: AgentBaseOptions);

    readonly id: string;
    readonly state: AgentBaseState; // the agent's own copy, mutable directly

    steer(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void>;
    send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void>;
    start(): void;
    abort(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void>;
    compact(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void>;
    waitForIdle(): Promise<void>;
    close(): Promise<void>;
}

interface AgentBaseAwaitOptions {
    await?: boolean; // default false: return once the agent has taken the request on
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
    instructions?: (ctx: Context) => MaybePromise<string>; // extends state.instructions
    tools?: (ctx: Context) => MaybePromise<readonly AnyAgentTool[]>; // extends state.tools
    aroundToolExecution?: (
        ctx: Context,
        execution: AgentBaseToolExecution,
    ) => MaybePromise<unknown>; // after argument validation, immediately around execute
    modelChanged?: (
        ctx: Context,
        change: AgentBaseModelChange,
    ) => MaybePromise<SessionSystemMessage | undefined>;
    beforeAgentLoop?: (ctx: Context) => void;
    beforeTurn?: (
        ctx: Context,
        turn: AgentBaseTurnStart,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    beforeInference?: (ctx: Context) => void;
    afterInference?: (ctx: Context, inference: AgentBaseInference) => MaybePromise<void>;
    afterTurn?: (
        ctx: Context,
        turn: AgentBaseTurn,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    afterAgentLoop?: (ctx: Context) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    afterAgentSettled?: (ctx: Context) => MaybePromise<void>;
}

interface AgentBaseToolExecution {
    callId: string;
    tool: AnyAgentTool;
    arguments: unknown;
    execute(): Promise<unknown>; // repeated calls join the same downstream execution
}

interface AgentBaseInference {
    state: SessionDoneState | undefined;
    tokens: SessionTokens | undefined; // absent when the response was cancelled or failed
    errorMessage?: string;
}

interface AgentBaseTurnStart {
    contextTokens: number | undefined; // measured size of the context this turn runs on
}

interface AgentBaseTurn extends AgentBaseTurnStart {
    aborted: boolean;
}

interface AgentEnvironment {
    osVersion: string;
    platform: AgentPlatform; // the platforms Node reports
    workingDirectory: string;
    shell: string;
}

interface AgentConfig {
    environment?: AgentEnvironment; // all of it, or none of it
    features?: { [featureName: string]: { [key: string]: unknown } };
}

interface AgentFeature {
    name: string;
    // Plus any subset of AgentBaseHooks, each taking its AgentFeatureScope after the context.
    // aroundToolExecution wrappers nest in feature order.
}

interface AgentFeatureScope {
    agent: AgentFeatureAgent;
    kv: AgentBaseKV; // this feature's store for this agent, outliving every run
    sharedKV: AgentBaseKV; // this feature's store, shared by every agent in the collection
    runKV: AgentBaseKV; // this feature's store for the run, erased when the agent settles
}

interface AgentFeatureAgent {
    id: string;
    provider: string; // registry ID
    providerKind: ProviderModelCompatibilityType | undefined; // how that ID was registered
    model: string | undefined;
    effort: SessionReasoningEffort | undefined;
    tier: SessionServiceTier | undefined;
}

class AgentBaseKV {
    readonly prefix: string; // absolute key prefix of this scope, ending with "."
    scoped(...segments: string[]): AgentBaseKV; // narrower store under `segments`
    read(ctx: Context, key: string): Promise<unknown>;
    list(ctx: Context, prefix?: string): Promise<readonly { key: string; value: unknown }[]>;
    write(ctx: Context, key: string, value: unknown): Promise<void>;
    delete(ctx: Context, key: string): Promise<void>;
    clear(ctx: Context): Promise<void>; // every entry in the scope, including narrower ones
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
    autoPermissionInstructions?: string;
    describeAutoPermissionAction?: (args: Static<Args>, ctx: Context) => string;
    requiresAutoOrFullAccess?: boolean;
    shouldReviewInAutoMode: (args: Static<Args>, ctx: Context) => boolean | Promise<boolean>;
    shouldRunInFullAccessInAutoMode?: (
        args: Static<Args>,
        ctx: Context,
    ) => boolean | Promise<boolean>;
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
    writeValueIfAbsent(ctx: Context, key: string, value: unknown): Promise<boolean>; // claim
    writeValueIfUnchanged( // compare and set
        ctx: Context,
        key: string,
        expected: unknown,
        value: unknown,
    ): Promise<boolean>;
    deleteValue(ctx: Context, key: string): Promise<void>;
    deleteValueIfPresent(ctx: Context, key: string): Promise<boolean>; // claim
}
```

The three conditional operations are what make one storage safe to share between owners who
cannot see each other: each performs its check and its write as a single atomic step, so of two
owners racing for one key exactly one is told it won.

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

| Strategy                 | Behavior                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steering + one-at-a-time | `steer` queues FIFO. After the current assistant response and all its tool calls finish, the oldest message injects, gets a response, then the next is handled.     |
| Steering + all           | After the current response and tool batch finish, every queued steering message injects together before one response.                                               |
| Send + one-at-a-time     | `send` waits until the agent would otherwise stop — no tool calls or steering remain — then injects one message and waits for its response before draining another. |
| Send + all               | Once the agent would otherwise stop, every queued sent message injects together before one response.                                                                |

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
hook failure during an incompatible change rejects the switch outright: the previous selection
stays effective and the history is not cleared. A
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
records append as usual. `compact` returns once the compaction has been asked for; with `await: true` it returns once it
has run, and callers waiting while one is pending or running all wait for that same shared
compaction, which resolves on completion and rejects when the provider reports failure, leaving
the history untouched.

Hooks receive the agent's context first. That context — shared by tool executions — is derived
once at construction and carries the agent's ID, provider registry ID, model, effort, and
service tier — all serializable values — readable through the exported `agentBaseId`,
`agentBaseProvider`, `agentBaseModel`, `agentBaseEffort`, and `agentBaseServiceTier` accessors.
The
`instructions` and `tools` hooks extend the mutable state — the state comes first, the hook's
answer follows — and are consulted for session creation, every inference request, compaction,
and tool lookup. They are correctness hooks: a failure there, including two tools sharing one
name and namespace in the merged list, fails the turn loudly instead of silently running with a
wrong configuration. Before every inference the provider-facing configuration is compared with
the one the session was created with, and a changed prompt or changed tool descriptors recreate
the provider session so the model always sees the tools the agent would actually execute. Both
hooks — like `modelChanged`, `afterTurn`, and `afterAgentLoop` — may return promises.

The context also carries a scoped key-value store, readable through the exported `agentBaseKV`
accessor. The store is an `AgentBaseKV` view over the agent's sorted store under
`kv.<agent id>.`, executing every operation through the agent's own persistence lock, with keys
always relative to the scope — a holder can neither see nor touch anything outside it, and
`scoped(segment)` narrows further. Hooks receive the session scope; a tool execution receives
the store narrowed to `call.<call ID>`, so a tool call persists under its own call ID and never
in another call's scope. Beside it the context carries a second store of the same shape, under
`kv.<agent id>.run.` and readable through `agentRunKV`, which belongs to the run rather than to
the conversation: the transaction that settles the agent erases the whole of it, so what a run
wrote about itself never reaches the next one. The `modelChanged` hook fires while the agent
holds its persistence lock, so its stores execute directly on the held lock instead of
deadlocking.

The lifecycle hooks bracket the loop's own structure. `beforeAgentLoop` fires when the loop
leaves the settled state and begins working, and `afterAgentLoop` fires when it would settle
back to idle; between them, each turn is bracketed by `beforeTurn` and `afterTurn`, and each
inference request inside a turn by `beforeInference` and `afterInference`. `beforeTurn`,
`afterTurn`, and `afterAgentLoop` may return an array of `AgentFeatureAction`s, all applied
together before the loop continues: `steer` and `send` queue a message through the ordinary
durable queues exactly as the public methods do, and `compact` triggers the shared compaction.
Actions from `beforeTurn` are carried out by the turn that is about to run — a compaction it
asks for happens before that turn's first inference; actions from `afterTurn` drive the loop
into another turn within the same loop span; actions from `afterAgentLoop` reopen the loop
instead of settling. Like every hook, a thrown lifecycle hook — or a failing action —
never fails the run.

The agent tracks the conversation's true size from the provider's own token counts, so nothing
has to estimate it or watch the event stream for it. `afterInference` receives how each response
ended and the counts it measured — the complete input context the provider received plus the
output it generated, which is where the next request starts from. Their sum becomes the agent's
context size, persisted under the `context` key and restored on load, so a restarted agent knows
how large its conversation is before it runs anything. A cancelled or failed response measures
nothing and reports no counts, leaving the last real measurement in place; a completed
compaction clears it, since the conversation it described is gone. Both turn hooks carry that
size as `contextTokens`, allowing an external feature to return a `compact` action from
`beforeTurn` when its own threshold is reached.

`abort` cancels the active turn; when idle it is a no-op. It returns once the cancellation has
been signalled, and with `await: true` once the loop has actually unwound.
The inference stream is abandoned and asked to close, a `done` event with state `cancelled` is
emitted, blocks that already finished stay in the history while an unfinished block is dropped
everywhere, and each still-running tool call settles as an error tool result saying it was
aborted — consuming its pending `tool.` entry so the batch leaves a complete context behind.
The queued turn request is dropped too, but messages still waiting in the steering and
send queues stay durable and join the next requested turn.

`Agent` is a thin wrapper around `AgentBase` that assembles its behavior from an array of
`AgentFeature`s instead of one hooks object. Each feature carries a required stable `name` and
implements any subset of the hooks; the agent merges them, in array order, into the singular
private hooks its internal base runs with. Every hook receives the agent's context first and its
own `AgentFeatureScope` second: the agent it is serving — identity, provider registry ID and
kind, model, effort, and tier — and its three stores, each narrowed to `feature.<name>`, so
features never see each other's persisted entries and renaming a feature orphans everything it
stored. `kv` belongs to that one agent's conversation, `sharedKV` to the whole collection, and
`runKV` to the run in progress and is erased when it settles. They are handed over rather than
read off the context, so a hook is given exactly what it is entitled to and can never be passed
a context that quietly means another agent. Features are independent: observing hooks — events and lifecycle brackets — fan out with
per-feature isolation so one throwing feature never silences the others, and lifecycle actions
concatenate with a failing feature losing only its own actions. Instructions and tools
concatenate after the base state and stay loud: a failing feature fails the turn. For a model
change every feature observes the change, the first returned handoff wins, and a feature
failure during an incompatible change rejects the switch so the history survives. `feature(name)`
hands back the instance running under that name, which is how the owner of an agent reaches what
belongs to it — a goal to pause, for instance.

`AgentSystem` is the type of a collection of agents, and `AgentSystemLocal` is the implementation
that lazily resolves and owns the `Agent` instances of one. An agent exists only
once `create(ctx, config)` has generated its cuid2 identity: the `AgentConfig` is validated,
persisted under the collection's storage, and then stays in effect for the agent's whole life,
so `resolve` on an ID that was never created is an error and `create` on one that already
exists is too. The configuration carries the environment the agent works on — `osVersion`,
`platform`, `workingDirectory`, and `shell`, all of them or none, so nothing the agent is told
about its machine is ever half-true — plus one opaque settings map per feature, keyed by feature
name; the agent never looks inside a feature's entry, so a feature validates its own against its
own schema. Every context the agent derives carries the configuration, readable
through the exported `agentConfig` and `agentFeatureConfig` accessors, from the first hook of a
feature all the way down to a tool execution.

A collection is given its features as instances the caller has already built and which are ready
to serve — there is no load step. One instance serves every agent the collection builds, so it
learns which agent a hook is running for from the scope it is handed rather than from anything
it was constructed with, and keeps what one run remembers keyed by that ID, dropping it when the
agent settles.

`start(ctx)` resolves and resumes every agent that was still
working when the previous process stopped, and `steer`, `send`, `abort`, and `compact` resolve
an agent by ID before acting on it, forwarding the same options the agent takes.
A feature's `sharedKV` is durable storage shared by every agent in the collection and outliving
all of them — an agent's own store belongs to its conversation and is cleared when the ID is
created again, so work one agent owes another lives here instead. `delete` closes an
agent and releases its identity while leaving what it wrote in place; creating the ID again is
what clears the store, so the new agent never wakes up inside its predecessor's conversation.

Asking and waiting are separate everywhere. `steer`, `send`, `abort`, and `compact` all return
once the agent has taken the request on, and `await: true` asks for the part only the run loop
can give — the durable write, the finished compaction, the unwound turn. That flag is refused,
with an error naming the problem, when the caller's context says it is running inside the loop of
the agent it is asking: a hook or a tool runs while its own agent's loop waits for it, so waiting
for that agent is waiting for itself. The check is per agent, so work inside one agent's loop may
still wait on another's — which is what makes a subagent's report to its parent safe. Two agents
each inside a tool are the one cross-agent case that cannot be allowed to wait: a waited-for
`compact` on an agent that is running a tool, asked from inside a turn, is refused outright,
because the tool it would wait for may be waiting for the caller. Note that
an operation nobody waits for still reports nothing: a fire-and-forget `send` whose durable write
fails is a message that silently never arrives.

`AgentSystemRef` and `AgentRef` are the same collection seen from inside an agent, and the only
form of it a context ever carries: a collection puts a reference on every context it derives, so
a feature hook or a tool — code some loop is waiting for — can never reach an operation that
waits for a loop. `close`, `waitForIdle`, `delete`, and `start` are absent entirely, `create` and
`resolve` hand back an `AgentRef` rather than the `Agent` that would carry them, and `compact`
and `abort` are requests that return once they have been made. The returned `AgentRef.id` is the
same system-generated cuid2 used for all later addressing.

A message is the one thing a caller here is told about, because accepting one is a durable queue
write rather than a turn: addressed to another agent, `steer` and `send` resolve once the message
really is part of that agent's conversation and reject when the write fails, which is what lets a
child know its parent has its report. Addressed to the agent the caller is running inside — whose
loop would have to make that write — the message is queued and nothing is waited for. The
context decides, since it names the agent the caller is in; a context naming none proves nothing
and waits for nothing. The agent's own `await: true`, which also covers a finished compaction and
an unwound turn, is never offered here and never passed on.

`currentAgentEnvironment()` reads a complete environment from the running process, ready to hand
to `create`.

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

## Chaos tests

`tests/chaos/` breaks the agent on purpose, in every way the machinery claims to survive, and
checks that the durable state keeps its promises anyway. The suites share one harness: a disk
that outlives each process, a store that can die or misbehave on a seeded schedule, and a model
that answers from the conversation it is handed rather than from a script — so a restarted agent
hears exactly what its dead predecessor did, down to the call IDs. Tools refuse to run for a
process that has already died, so a zombie's side effect is never mistaken for the world's.

| Suite                     | What it breaks                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crashRecovery`           | the process dies at a random operation, again and again, until one is finally left alone to finish                                                                  |
| `queues`                  | a mixture of sent and steering messages, each accepted just before a crash                                                                                          |
| `compaction`              | the one operation that destroys history, interrupted inside its transaction                                                                                         |
| `compactionUnderLoad`     | the same, with messages still waiting in both queues and calls in flight                                                                                            |
| `interruption`            | the turn is aborted at a random point in the event stream, sometimes while crashing too                                                                             |
| `flakyStore`              | writes fail and the process keeps running, so the agent has to cope rather than stop                                                                                |
| `concurrency`             | nothing crashes; messages, interruptions and starts simply arrive all at once                                                                                       |
| `modelSwitch`             | an incompatible model change, which resets the conversation, crashed around                                                                                         |
| `ownershipRaces`          | boundaries one owner's lock cannot cover: two live instances on one store, two managers claiming one identity, and lifecycle calls racing the work they own         |
| `managerRecoveryRaces`    | the seam between a live agent, its collection's discovery index, and a second collection over the same durable identity                                             |
| `coreLoopConsistencyGaps` | the loop stopped at exact ownership handoffs: a lock that escapes its hook, a batch split in half, a phantom turn, a reentrant close, a contradicted terminal event |
| `featureConsistencyRaces` | features under partial failure: a half-finished spawn, a lost completion, a goal completed and paused at once, and scopes that collide through a dot                |

Each suite runs 60 seeds by default. `CHAOS_SEEDS=5000 pnpm test` turns the same suites into a
long hunt for rarer interleavings; the whole set has been swept clean at that size.

What the seeds prove, however the run was broken:

- every message reaches the conversation exactly once — none lost between the durable queue and
  the context, none replayed by the resume that followed, and each queue keeps its order across
  restarts;
- every call is settled exactly once, no result exists without its call, and the conversation
  never keeps a tool call the model will not get an answer for;
- a non-durable tool never runs twice, while a durable one may;
- nothing is reported as finished before it is durable;
- a compacted conversation comes back whole or replaced, never half-erased, and a message still
  waiting in a queue survives the replacement;
- an incompatible model switch lands on one side or the other, never the old history under the
  new model;
- the agent settles owing nothing: no queued message, no pending call, and a final answer — and
  says so durably, so another process reads a committed fact rather than guessing;
- one accepted message is answered once even when two live owners hold the same store, and a
  turn always answers the durable conversation rather than the one its instance remembers;
- one response has exactly one terminal event, and a store handed to a hook is a capability that
  expires with the call.

Breaking things on purpose has paid for itself several times over. Every bug below was found by
a chaos seed and has its own focused test in `tests/blackbox/`:

- **Queue keys collided across a restart.** The sequence counter began again at zero in each
  process, so two messages accepted in the same millisecond by two processes shared one key and
  the first was overwritten. Keys are now ordered by what the store already holds.
- **A crash between a response's last block and the batch commit left a call nobody would ever
  answer.** There was no pending entry to resume from. Such calls have certainly not run, since
  the commit precedes every execution, so they are recovered as the batch they never got to be.
- **A turn that failed after emitting a call left it unanswered**, and the next message was
  appended behind it. A turn now settles its own calls with an error result before it gives up.
- **A conversation could still be stranded** when even that failed, with the gap buried under
  later messages. Load repairs it by rewriting the conversation atomically — the only way, since
  the answer belongs beside its call rather than at the end.
- **A failed turn was never retried.** The note it leaves behind means the question was never
  answered, so a restarted agent now owes a response and has the note for context.
- **A restart could answer a compaction.** Whether a restart owes a response is now decided by
  the last durable record rather than the message it ends on: a consumed message, a tool result
  or a failure note is owed an answer, while a replacement written by a compaction is not a
  question and gets none. A replacement also keeps whatever joined the conversation after its
  snapshot, and a consumed message kept that way is still owed an answer — which is not visible
  in the messages, so the rewrite that knew records it on the record it writes.
- **Two owners of one agent ID could collide on a queue key**, and the second write silently
  replaced a message whose `send` had already resolved. Every key now ends in a segment
  identifying its writer, so simultaneous acceptance can order two messages arbitrarily but can
  never lose one.
- **Compaction erased work it had never seen.** The suffix it preserved came from its own
  memory, so a record another owner committed while the provider was summarizing was wiped by
  the clear-and-replace. The boundary is now a record count taken from the store, and the suffix
  is rebuilt from the store inside the commit.
- **Abort did not own the whole turn.** The abort scope now opens before the turn's hooks and
  loading rather than at its first inference, so a turn cancelled during startup never reaches
  the model at all.
- **A compaction requested during an aborted turn never settled.** Dropping the turn request
  dropped the only thing that would have run it, leaving every `compact()` caller waiting for
  ever. Abort and close now settle a compaction nobody will carry out.
- **A response's leftovers overlapped the next request.** A stream still closing, or a tool that
  an abort settled in the conversation but which is still running, kept hold of a stateful
  session while the next request went out. The next request now waits for that work — but an
  abort does not, so a stream or tool that ignores cancellation can never hold a cancellation
  open.
- **Close raced the work it had already accepted.** A `send` that had been admitted could still
  be writing when `close()` resolved. Close is now a barrier: nothing new is admitted, and
  everything already admitted is written, answered, and only then is the session destroyed.
- **Two managers could both create one agent ID**, each returning a live agent while storage
  kept a single configuration. Creation now claims the identity with an atomic write-if-absent,
  so exactly one creator is told it won.
- **A creation that failed halfway still took the name.** The configuration was committed before
  the agent was built, so a feature that refused to load left an identity behind that no agent
  answered to and no caller could claim again. A creation that produces no agent now rolls its
  identity back, and a subagent spawn whose initial task never reached the child does the same.
- **A message could be acknowledged before anything could find the agent that owed it.** The
  agent now records that it owes an answer in the same transaction that accepts the message, and
  the collection publishes it in its discovery index before the send resolves.
- **Settling was inferred rather than committed.** The index deletion at the end of a settle
  could erase a marker owed to a message accepted while that deletion was in flight. Settling is
  now committed under the persistence lock and only when the durable queues really are empty, so
  an agent that owes an answer is never durably described as settled — and discovery asks that
  committed fact instead of reading another component's state.
- **One durable message could be answered twice.** Two live owners over one store each loaded it
  into memory and each consumed it. A consumption now claims every entry with an atomic delete
  inside its transaction, and a batch that wins nothing rolls back untouched.
- **A live owner could answer a conversation that no longer existed**, having loaded the durable
  state once and kept it. Every turn now reloads before it decides anything, so a model switch
  or an appended message from another owner is in force by the next turn.
- **A hook could keep the store it was lent.** `modelChanged` runs inside the persistence lock
  and receives a store bound to that hold; retaining it let later writes bypass the lock
  entirely. The store is now a capability released when the hook returns.
- **An external send could land in the middle of a hook's decision.** Two messages returned by
  one hook were written one lock hold at a time. They are now accepted as one batch, so a caller
  arriving during it lands after all of it.
- **A send accepted mid-inference bought an empty turn.** The running turn drained it but left
  the request flag raised, so the loop ran again with nothing to do and fired a full set of
  lifecycle hooks around it. Consuming the last queued work now clears the request it answered.
- **Close could destroy one session twice.** An idle agent reached `destroy()` before the shared
  shutdown promise had been assigned, so a participant reentering from inside `destroy` started
  a second shutdown. The barrier is now published before any of the shutdown runs.
- **One response could report two terminal outcomes.** An abort observed after a normal `done`
  appended a contradictory `cancelled` event for the same response. A cancellation is now only
  reported when the turn actually had something left to cancel.
- **Two scopes could collide through a dot.** A feature named `alpha.beta` and the relative key
  `beta.state` under the feature `alpha` produced the same absolute key, so one silently read
  and overwrote the other's state. Scope segments are now escaped, and each is exactly one level.

## Real gym

`tests/real-gym/` runs the agent against live models instead of scripted ones. Each scenario
goes through an `AgentSystemLocal` collection, exactly the way the product assembles an agent: the agent
is created with its configuration — the real machine environment and the gym's own feature
config — and resolved from the collection, which runs one shared `FeatureGymHarness` that
contributes a real `record_answer` tool. So the assembled instructions, tool set, loop, and
durable records are all the product's own, and the credentials are the ones the installed Codex
and Claude Code assistants already manage, resolved in the same order Rig itself resolves them.
Nothing is mocked, so the suite runs only when it is asked for by name:

```sh
pnpm --filter @slopus/happy-agent-base test:real
```

The ordinary `test` script skips it. A machine that is not signed in to a vendor fails that
vendor's scenario with a message saying so rather than pretending the product is broken.

A `TracingProvider` wraps the real provider and records, at the wire boundary, the session's
system prompt and tools, every request's complete conversation, every streamed event with the
millisecond it arrived, the token counts, and any failure. After the run, every trace is
rendered into one self-contained page at `.context/real-gym/report.html`: a summary table of
each scenario's vendor, model, outcome, duration, inferences, tool calls, and tokens, then for
each scenario the agent's facts — its features, the model catalog it was offered, and its
environment — the assembled system prompt with the tools the model was shown, every inference's
reasoning, text, tool calls, conversation, and event stream, and finally the durable transcript
a restart would rebuild. The renderer has its own ordinary unit test, so the report stays
covered without spending tokens.

The live suite has already earned its keep twice: it exposed a provider stream left open after
`done`, and a lost message when a `send` landed while the agent was loading its history.
