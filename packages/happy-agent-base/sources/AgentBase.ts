import type {
    BaseSession,
    SessionAssistantBlock,
    SessionDoneState,
    SessionEvent,
    SessionMessage,
    SessionReasoningEffort,
    SessionServiceTier,
    SessionSystemMessage,
    SessionTokens,
    SessionToolCallBlock,
    SessionToolResultMessage,
    SessionUserMessage,
} from "@slopus/happy-providers";
import { areProviderModelsCompatible } from "@slopus/happy-providers";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
    asyncLock,
    createContextNamespace,
    deterministicStringify,
    withLifetime,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";

import { withAgentContext, withAgentKV } from "./AgentContexts.js";
import { taskContextBeforeToolCall, withAgentTaskContext } from "./AgentTaskContext.js";
import { AgentBaseKV } from "./AgentBaseKV.js";
import {
    AGENT_BASE_PENDING_KEY,
    agentBasePendingStateOf,
    type AgentBasePendingStage,
    type AgentBasePendingState,
} from "./AgentBasePending.js";
import type { AgentBaseHooks, MaybePromise } from "./AgentBaseHooks.js";
import type { AgentBasePersistence, AgentBaseRecord } from "./AgentBasePersistence.js";
import { agentBaseStoreLock, agentBaseWithStoreStill } from "./AgentBaseStoreLock.js";
import type { AgentBaseState } from "./AgentBaseState.js";
import { AgentProviders } from "./AgentProviders.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

/** Race winner when an abort interrupts a wait on the stream or a running tool. */
const ABORTED = Symbol("aborted");

/**
 * The agents whose run loop the current execution is running inside. Hooks and tool executions
 * receive a context carrying this, so an operation that would wait for the very loop it is part
 * of can say so instead of hanging for ever.
 */
const insideTurn = createContextNamespace<readonly string[]>("agentInsideTurn", []);

/**
 * The same fact as `insideTurn`, tracked by the runtime rather than carried by a context. Not
 * every operation takes one — `close` is the whole agent's lifetime and has no call to carry it —
 * and a context can always be one the caller kept from somewhere else, so the run loop marks its
 * own execution too. Everything the loop awaits, however deep, is inside this scope; another
 * agent's loop replaces the scope rather than extending it, because that loop is a lifetime of
 * its own and outlives whatever happened to start it.
 */
const insideLoops = new AsyncLocalStorage<readonly string[]>();

/**
 * How long a close asked for from inside the agent's own run loop waits for the shutdown before
 * telling its caller it cannot be waited for. Long enough that a caller which has already let go
 * hears the shutdown finish, short enough that one still holding the loop is told promptly.
 */
const INSIDE_CLOSE_REPORT_MS = 15;

/** Rolls a consumption back when every entry in its batch was already taken by another owner. */
const LOST_QUEUE_RACE = Symbol("lostQueueRace");

/** How a message queue drains: one message per model response, or every queued message at once. */
export type AgentBaseQueueMode = "one-at-a-time" | "all";

/**
 * Inference settings carried by a queued message. An omitted field keeps the previously
 * effective value; the first message without a value falls back to the constructor default,
 * though relying on that default is discouraged — prefer sending settings with the message.
 */
export interface AgentBaseMessageOptions {
    /** The registry ID of the provider to switch to. */
    readonly provider?: string;
    /** The model to switch to; an incompatible one resets the conversation. */
    readonly model?: string;
    /** How hard the model should think about the request. */
    readonly effort?: SessionReasoningEffort;
    /** Which of the provider's service tiers to bill and schedule the request on. */
    readonly serviceTier?: SessionServiceTier;
}

/**
 * Whether an operation resolves once the agent has taken the request on, or once the agent has
 * carried it out. Every operation that asks something of an agent accepts this, and every one of
 * them defaults to the first: asking is the operation, and waiting is opt-in.
 *
 * The reason is re-entrancy. An agent does its work in one run loop, and while a hook or a tool
 * runs, that loop is waiting for it — so code in that position that waits for its own agent waits
 * for itself. Rather than offer some operations in a waiting form and others not, every operation
 * returns as soon as the request is registered, and `await: true` asks for the rest. That flag is
 * refused, loudly, when the caller's context says it is running inside the loop of the very agent
 * it is asking, which is the only case where the wait could never end.
 */
export interface AgentBaseAwaitOptions {
    /**
     * Wait for the operation to finish rather than for it to be accepted. Refused from inside the
     * agent's own run loop.
     */
    readonly await?: boolean;
}

/** A durably queued message together with the settings it carries. */
interface QueueEntry {
    /** The store key the message was written under, and the one a consumption claims it by. */
    readonly key: string;
    readonly message: SessionUserMessage;
    /** The settings this message makes effective when it is consumed. */
    readonly options: AgentBaseMessageOptions;
}

/** One call in a dispatched batch, with the reason it must not run when it is ambiguous. */
interface ToolBatchEntry {
    /** The pending-tool key the call is durable under until its result commits. */
    readonly key: string;
    readonly call: SessionToolCallBlock;
    /** Present when the call must be answered with this refusal instead of being executed. */
    readonly rejected?: string;
}

/** One message offered to a durable queue, before it has a key. */
interface QueueRequest {
    /** Which of the two queues it belongs in, and so when it will be injected. */
    readonly kind: "steering" | "send";
    readonly message: SessionUserMessage;
    readonly options: AgentBaseMessageOptions;
}

/** Everything an agent session is constructed with; only the identity and store are required. */
export interface AgentBaseOptions {
    /** Stable session identity supplied by the caller. */
    readonly id: string;
    /** The registry providers are resolved from, at session creation time. */
    readonly providers: AgentProviders;
    /** The registry ID of the provider to use; serializable alongside model and effort. */
    readonly provider: string;
    /** The append-only store the conversation, the queues, and the settings live in. */
    readonly persistence: AgentBasePersistence;
    /** Observers and correctness hooks the run is assembled from; `Agent` merges features here. */
    readonly hooks?: AgentBaseHooks;
    /** Copied into the agent's own mutable `state`. */
    readonly initialState?: Partial<AgentBaseState>;
    /** The initial model, superseded by the first message that carries one. */
    readonly model?: string;
    /** The initial reasoning effort, superseded by the first message that carries one. */
    readonly effort?: SessionReasoningEffort;
    /** The initial service tier, superseded by the first message that carries one. */
    readonly serviceTier?: SessionServiceTier;
    /** How the steering queue drains; one message per response by default. */
    readonly steeringMode?: AgentBaseQueueMode;
    /** How the send queue drains; one message per response by default. */
    readonly sendMode?: AgentBaseQueueMode;
}

/**
 * A single agent session over one provider. Messages arrive through two FIFO queues: steering
 * messages inject as soon as the current assistant response and its tool batch finish, while
 * sent messages wait until the agent would otherwise stop — no tool calls or steering remain.
 * Each queue drains per its configured mode, and the conversation is durable through
 * append-only persistence reloaded at the start of every turn.
 *
 * The rest of this comment is the list of promises the implementation has to keep. They are
 * written down because most of them are invisible in ordinary use and only show themselves when
 * a process dies, two owners share a store, or a caller races the loop — every one of them was
 * bought with a bug found by `tests/chaos/`, and each has a focused test that fails without it.
 *
 * ## Serialization
 *
 * One lock serializes every persistence operation together with its in-memory effect, so storage
 * order always matches history order and a load never overlaps an append. Anything that decides
 * from durable state resolves that state inside the lock rather than capturing it beforehand; a
 * reference taken before a wait can belong to a history that has since been replaced.
 *
 * ## Accepting a message
 *
 * A message is accepted exactly once, or not at all. Its durable write and the writes of every
 * other message in the same batch commit in one transaction under one hold of the lock. So:
 *
 * - `steer` and `send` with `await: true` resolve only once the message is durable; a failed
 *   write keeps it out of the conversation entirely. Without the flag they return early, but the
 *   acceptance is the same one, and a close still waits for it.
 * - Messages a hook returns from one decision are accepted as one batch. A caller arriving while
 *   that batch is being written lands after all of it, never between two halves of one thought.
 * - Queue keys order by what the store already holds and end in a segment identifying their
 *   writer, so two owners accepting in the same millisecond may order arbitrarily but can never
 *   overwrite one another.
 * - An agent holding a durable message never describes itself as settled.
 *
 * ## Consuming a message
 *
 * A consumption claims each entry with an atomic delete inside its own transaction, so one
 * durable message is answered exactly once however many live owners hold it in memory. A batch
 * that claims nothing rolls back having changed nothing. A message is never durable in both the
 * queue and the context, or in neither, and memory changes only after the commit.
 *
 * ## Turns
 *
 * A turn answers the durable conversation, not the one this instance remembers: it reloads
 * before it decides anything, so an appended message or a model switch from another owner is in
 * force by the next turn. A turn that consumes the last queued work clears the request it just
 * answered, rather than buying an extra turn with an empty queue and a full set of hooks.
 *
 * ## Tool calls
 *
 * A batch runs its calls at the same time, each in its own persistence scope, and commits their
 * results in batch order. Results are matched back by call ID, so a response that used one ID
 * twice has no answer the model could tell apart: that ID is kept once and refused before
 * anything runs, since a refusal after the fact would not undo the side effect.
 *
 * The conversation never keeps a tool call the model will not get an answer for:
 *
 * - A batch is committed before any call in it runs, so a batch found uncommitted after a crash
 *   has certainly not run and is dispatched as the fresh batch it never became.
 * - A response that emits a call but does not end in one, and a turn that fails while owing
 *   results, settle their own calls with error results before appending anything behind them.
 * - A conversation loaded with a call stranded under later messages is repaired atomically at
 *   load, since the answer belongs beside its call rather than at the end.
 * - A non-durable tool never runs twice; a durable one may.
 *
 * ## Compaction
 *
 * A compaction runs before a turn's first inference, so the model always receives a settled
 * conversation. It replaces the history whole or not at all, and the suffix it preserves is
 * rebuilt from the store inside the commit — from a record count taken at the snapshot, so work
 * another owner committed while the provider was summarizing survives. A compaction nobody will
 * carry out is rejected rather than left waiting.
 *
 * ## Model changes
 *
 * An incompatible provider or model change resets the conversation; a compatible one keeps it.
 * Either way the change lands on one side or the other, never the old history under the new
 * model. `modelChanged` runs inside the lock and is lent a store bound to that hold — a
 * capability released when the hook returns, so it cannot be retained to bypass the lock later.
 * A failing handoff rejects an incompatible switch outright rather than costing the history.
 *
 * ## Recovery
 *
 * Whether a restart owes a response is decided by the last durable record: a consumed message, a
 * tool result, or a failure note is owed an answer, while a replacement written by a compaction
 * is not a question and gets none.
 *
 * ## Abort
 *
 * An abort owns the whole turn. Its scope opens before any of the turn's work — its hooks and its
 * loading as much as its inference — so a turn cancelled while it is still starting up never
 * reaches the model at all, rather than being cancelled only once it was already talking.
 *
 * What a cancelled turn leaves behind is fixed:
 *
 * - Assistant blocks that finished stay in the history; a block still being streamed is dropped,
 *   because half a block is not something the model said.
 * - Tool calls still running are settled in the conversation as aborted error results, so the
 *   history owes nothing, and the turn ends without waiting for the tools themselves. A tool that
 *   never notices cancellation therefore cannot hold the cancellation open — but it is still
 *   running, so the *next* provider request waits for it before reusing the stateful session.
 * - Messages already queued stay durable and join the next requested turn. An abort cancels the
 *   turn, not the work waiting for one.
 * - A compaction requested during the turn is rejected rather than left pending, because dropping
 *   the turn request drops the only thing that would have carried it out.
 * - Exactly one terminal event is reported. A cancellation seen after a response already reported
 *   its own outcome adds nothing, since that response is over.
 *
 * `abort` signals and returns, because the cancellation is complete once it is signalled.
 * `abort(ctx, { await: true })` additionally waits for the loop to stop, which is what an owner
 * outside the agent usually wants and what code inside it must not ask for — see below.
 *
 * ## Close
 *
 * Close is a barrier, published before any of the shutdown runs. Nothing new is admitted from
 * the moment it is called; everything already admitted is written and answered, and only then is
 * the provider session destroyed. Every caller shares that one shutdown, including one
 * reentering from inside session destruction, so a session is never destroyed twice.
 *
 * ## Hooks
 *
 * Hooks observe the run and never fail it. Neither a throwing hook nor a failing hook-driven
 * action ends a turn.
 *
 * ## Re-entrancy
 *
 * A hook or a tool runs while the loop is waiting for it, so anything it asks of its own agent
 * that only the loop can deliver would wait for itself. Rather than leave that to be remembered
 * per operation, asking and waiting are separated everywhere:
 *
 * - `steer`, `send`, `abort` and `compact` are safe from anywhere in their asking form, which is
 *   the default. Each registers what it registers and returns; the loop acts on it afterwards.
 * - `await: true` asks for the part only the loop can give. Contexts handed to hooks and tools
 *   record which agents' loops the execution is inside, so the flag is refused with an error that
 *   names the problem instead of hanging. The check is per agent: work inside one agent's loop
 *   may still wait on another's, which is what makes a subagent's report to its parent safe.
 * - The refusal is uniform even where a particular wait would have happened to work. A tool that
 *   waits for its own abort, for instance, does unwind — the batch races each execution against
 *   cancellation — but that is a property of tool batches rather than of abort, and a rule that
 *   holds only in one position is worse than no rule.
 * - A hook that wants a compaction has a better option than requesting one: the
 *   `{ type: "compact" }` action it returns lands exactly where the loop can act on it, in order
 *   with the rest of that decision.
 * - `close` and `waitForIdle` take no context, so they cannot be checked and will simply hang.
 *   Both are nothing but a wait for the run to finish. Close the agent from the caller that owns
 *   its lifetime.
 *
 * `AgentRef` and `AgentSystemRef` drop the two unguarded waits, and are what code running inside
 * an agent should be handed.
 */
export class AgentBase {
    /** The caller-supplied session identity: the name of this agent's store and of its loop. */
    readonly id: string;
    /**
     * The agent's own copy of the initial state, mutable directly; every inference reads the
     * current values.
     */
    readonly state: AgentBaseState;

    /**
     * The agent's own lifetime, without the selection on it. Every context the agent derives
     * starts here, so a change of provider or model rebuilds one context from a known base
     * rather than layering another value onto whatever the last one happened to carry.
     */
    readonly #baseCtx: Context;
    /** The base context extended with the effective selection and the agent's key-value store. */
    #ctx: Context;
    /** The registry the provider ID is resolved through, each time a session is created. */
    readonly #providers: AgentProviders;
    /** The registry ID of the provider in force; durable, so a restart resumes on the same one. */
    #providerId: string;
    /** The append-only store behind the conversation, the queues and the persisted settings. */
    readonly #persistence: AgentBasePersistence;
    /** The model in force. Changing it to an incompatible one resets the conversation. */
    #model: string | undefined;
    /** The reasoning effort in force. */
    #effort: SessionReasoningEffort | undefined;
    /** The service tier in force. */
    #serviceTier: SessionServiceTier | undefined;
    /** The single set of hooks the run is observed by and its configuration extended from. */
    readonly #hooks: AgentBaseHooks;
    /**
     * Serializes every persistence operation together with its in-memory effect, so storage
     * order always matches history order and a load never overlaps an append. The lock belongs
     * to the store, so an owner inspecting the same store sees only whole steps.
     */
    readonly #persistenceLock: AsyncLock;

    /** The session-scoped key-value store carried on every context the agent derives. */
    readonly #kv: AgentBaseKV;
    /** Whether steering drains one message per response or all of them at once. */
    readonly #steeringMode: AgentBaseQueueMode;
    /** Whether sends drain one message per response or all of them at once. */
    readonly #sendMode: AgentBaseQueueMode;

    /** The provider session requests run on, created on first use and stateful thereafter. */
    #session: BaseSession | undefined;
    /** The provider-facing configuration the current session was created with. */
    #sessionConfig: string | undefined;
    /** The conversation as this instance last knew it, reloaded from the store every turn. */
    #messages: SessionMessage[] = [];
    /** The durable steering queue, in the order its keys sort. */
    #steering: QueueEntry[] = [];
    /** The durable send queue, in the order its keys sort. */
    #sends: QueueEntry[] = [];
    /** A dispatched tool batch whose results have not all landed yet, and so has to be resumed. */
    #pendingTools: { readonly key: string; readonly call: SessionToolCallBlock }[] = [];
    /**
     * True when the pending tools were reconstructed from an unanswered trailing tool call
     * rather than read from the durable batch, so the batch still has to be committed before
     * anything runs.
     */
    #pendingToolsUndispatched = false;
    /** How many tool batches are running, so a caller can tell a waiting turn from a busy one. */
    #toolsRunning = 0;
    /** The in-flight or finished load of the durable state; cleared at the start of every turn. */
    #loaded: Promise<void> | undefined;
    /**
     * Identifies this instance's writes, so no other writer can produce one of its keys. It is a
     * UUID rather than a number drawn from the general-purpose generator, because two owners of
     * one store acknowledging a message each are relying on it to keep their keys apart, and a
     * generator that can be seeded — or replaced — would let both of them claim the same one.
     */
    readonly #writer = randomUUID();
    /**
     * The kind of the last durable record, which says what the conversation is waiting for far
     * more precisely than the message it ends on: a consumed message, a tool result or the note
     * a failed turn leaves behind is owed a response, while a replacement written by a
     * compaction is owed nothing at all.
     */
    #lastRecordType: AgentBaseRecord["type"] | undefined;
    /**
     * Whether that last record was a replacement that ended on a message still owed an answer.
     * Only the rewrite that wrote it can tell a summary's own last message from a suffix it kept.
     */
    #lastRecordContinuesInference = false;
    /**
     * How many durable records the in-memory conversation accounts for: the ones it was loaded
     * from, plus every one this instance has appended since. A rewrite replaces exactly those.
     * Counting the store afresh would treat records this instance has never seen as already
     * summarized and erase them; forgetting its own appends would carry records the summary
     * already covers into the replacement a second time.
     */
    #loadedRecordCount = 0;
    /**
     * Whether this instance has checked whether a cut-off run should resume inference. The
     * question is only meaningful once, against the state the agent first loaded: afterwards a
     * trailing user message is ordinary, since a response may legitimately have no blocks.
     */
    #recoveryChecked = false;
    /**
     * The outstanding work this agent has recorded, held in memory exactly as the store holds
     * it. Its presence is the whole of the active flag, so the one thing anyone outside can ask
     * about the agent is answered from here without touching the disk.
     */
    #pending: AgentBasePendingState | undefined;
    /**
     * The pending state this instance last wrote, so a write that would change nothing is
     * skipped. The loop passes through the same stage many times in a turn, and a store is not
     * worth touching to tell it what it already says.
     */
    #pendingWritten: string | undefined;
    /**
     * The outstanding work this agent's store already held when this instance first wrote to it:
     * what a process that died mid-run left behind, or nothing when the last run settled
     * cleanly. It is what recovery decides from, in place of guessing from the transcript's
     * shape.
     */
    #inherited: AgentBasePendingState | undefined;
    /** Whether that inherited record has been read; it can only be read before it is overwritten. */
    #inheritedRead = false;
    /**
     * The compaction that has been asked for and not carried out yet, together with the promise
     * every caller waiting for it shares. Requesting one while it is pending joins that promise
     * rather than queueing a second compaction.
     */
    #compaction:
        | {
              readonly promise: Promise<void>;
              readonly resolve: () => void;
              readonly reject: (error: unknown) => void;
          }
        | undefined;
    /** The scope the current stretch of work is cancelled on, which an abort signals. */
    #abortController: AbortController | undefined;
    /**
     * Raised when close begins. Only the tool batch listens: a running tool may be waiting for
     * the close itself, so the shutdown stops waiting for tools while still finishing the
     * inference stream and everything already accepted.
     */
    readonly #closeController = new AbortController();
    /**
     * The true size of the conversation in tokens, as the provider last measured it. Durable,
     * so a restart keeps knowing how large the conversation is, and cleared whenever the
     * conversation is replaced.
     */
    #contextTokens: number | undefined;
    /** Whether the current turn was cancelled before it could finish. */
    #turnAborted = false;
    /** Whether something has asked for a turn that has not been answered yet. */
    #turnRequested = false;
    /** The run loop while it is running; the field is cleared once it has actually stopped. */
    #runPromise: Promise<void> | undefined;
    /** The barrier: true from the moment close is called, and nothing new is admitted after it. */
    #closed = false;
    /** The one shutdown every closing caller shares, so a session is never destroyed twice. */
    #closing: Promise<void> | undefined;
    /** Operations accepted from a caller and not finished yet; a close waits for every one. */
    readonly #admitted = new Set<Promise<void>>();
    /**
     * Work from an earlier response that is still unwinding: a provider stream that has not
     * finished closing, or a tool that was settled in the conversation by an abort and is still
     * running. The next request waits for it, because the session is stateful and its previous
     * user has not let go. An abort does not wait for it: a stream or tool that ignores being
     * cancelled must never be able to hold the cancellation open.
     */
    readonly #settling = new Set<Promise<unknown>>();
    /**
     * The part of that unwinding a close has to wait for: a response iterator still letting go
     * of the provider session. Destroying the session underneath it would hand the provider two
     * owners of one session at once.
     */
    readonly #streamCleanup = new Set<Promise<unknown>>();

    /**
     * A new agent, wired to its options and touching no storage at all. Use this for an identity
     * with no durable state yet; whatever the agent needs from the store is read by its first
     * turn.
     */
    static create(ctx: Context, options: AgentBaseOptions): Promise<AgentBase> {
        return Promise.resolve(new AgentBase(ctx, options));
    }

    /**
     * An agent for an identity that may already have durable state, with the one externally
     * meaningful fact about that state — whether it has work left — read before it is handed
     * back, so `active` is answerable straight away.
     *
     * Only the flag is read. The conversation, the queues and the settings are deliberately not:
     * they are needed by the first turn and by nothing before it, so an owner resuming a hundred
     * identities at startup pays for a hundred small reads rather than a hundred transcripts.
     * The rest loads on the way into the turn that actually needs it.
     */
    static async load(ctx: Context, options: AgentBaseOptions): Promise<AgentBase> {
        const agent = new AgentBase(ctx, options);
        await agent.#loadPendingState();
        return agent;
    }

    /**
     * Read the outstanding work the store already holds, before this instance has written any of
     * its own. It is both what `active` answers from and what an interrupted run is recognized
     * by, so reading it here leaves the later stage writes nothing to learn from the store.
     */
    async #loadPendingState(): Promise<void> {
        await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
            const stored = await agentBasePendingStateOf(lockCtx, this.#persistence);
            this.#inherited = stored;
            this.#inheritedRead = true;
            this.#pending = stored;
            this.#pendingWritten =
                stored === undefined ? undefined : deterministicStringify(stored);
        });
    }

    /**
     * Build the agent from its options, without touching the store. Nothing is loaded here: the
     * durable state is read by the first turn, so constructing one stays cheap even for a session
     * nobody goes on to run. Private, because an agent is made by `create` or by `load`, and
     * which of the two the caller means is worth saying.
     */
    private constructor(ctx: Context, options: AgentBaseOptions) {
        this.id = options.id;
        // An agent is its own lifetime. Whatever call happened to construct it — a tool of
        // another agent, most often — is not a loop this one runs inside, so an inherited
        // marker is dropped rather than carried into work that outlives that call.
        this.#baseCtx = insideTurn.set(ctx, [options.id]);
        this.#providers = options.providers;
        this.#providerId = options.provider;
        this.#persistence = options.persistence;
        this.#persistenceLock = agentBaseStoreLock(options.persistence);
        this.#hooks = options.hooks ?? {};
        this.state = {
            instructions: options.initialState?.instructions ?? "",
            tools: [...(options.initialState?.tools ?? [])],
        };
        this.#model = options.model;
        this.#effort = options.effort;
        this.#serviceTier = options.serviceTier;
        this.#kv = new AgentBaseKV(this.#persistence, `kv.${options.id}.`, (ctx, work) =>
            this.#persistenceLock.runInLock(ctx, work),
        );
        // Everything the agent does — hooks and tool executions included — runs on a context
        // carrying its provider and the currently effective model, effort, and service tier.
        this.#ctx = this.#deriveCtx();
        this.#steeringMode = options.steeringMode ?? "one-at-a-time";
        this.#sendMode = options.sendMode ?? "one-at-a-time";
    }

    /**
     * The context everything the agent does runs on: its identity and effective selection, plus
     * the session-scoped key-value store. Rebuilt whenever the selection changes.
     */
    #deriveCtx(): Context {
        const ctx = withAgentContext(this.#baseCtx, {
            id: this.id,
            provider: this.#providerId,
            model: this.#model,
            effort: this.#effort,
            serviceTier: this.#serviceTier,
        });
        return withAgentKV(ctx, this.#kv);
    }

    /**
     * Whether the agent has anything left to do. This is the only thing about an agent's state
     * anyone outside it may read: the queues and the stage behind this answer are the run's own
     * business, and can be cleared but never inspected. Even this is rarely wanted — it is here
     * for the owner deciding which agents a restarted process has to resume.
     */
    get active(): boolean {
        return this.#pending !== undefined;
    }

    /**
     * Record what the agent is doing, so a process that dies here is discovered owing exactly
     * this. Writing runs on the caller's context: given a transaction's context it commits with
     * whatever else that transaction is writing, which is how a consumed message and the
     * inference it owes become durable as one fact rather than two.
     */
    async #recordPending(ctx: Context, pending: AgentBasePendingState): Promise<void> {
        const serialized = deterministicStringify(pending);
        if (this.#pendingWritten === serialized) return;
        await this.#persistence.writeValue(ctx, AGENT_BASE_PENDING_KEY, pending);
        this.#pending = pending;
        this.#pendingWritten = serialized;
    }

    /**
     * Record the stage the run has reached, taking the store lock when not already inside it.
     *
     * The first of these also reads what the store already held, before overwriting it. That
     * reading is the only chance to see it: from this point the record says what this instance
     * is doing, and a run interrupted by a dead process would be indistinguishable from the one
     * starting here.
     */
    async #enterStage(stage: AgentBasePendingStage): Promise<void> {
        const pending: AgentBasePendingState = { stage };
        if (deterministicStringify(pending) === this.#pendingWritten && this.#inheritedRead) return;
        try {
            await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
                if (!this.#inheritedRead) {
                    this.#inheritedRead = true;
                    this.#inherited = await agentBasePendingStateOf(lockCtx, this.#persistence);
                }
                await this.#recordPending(lockCtx, pending);
            });
        } catch {
            // Losing the record costs recovery precision, never the work itself: the turn is
            // already running and will answer whatever it was going to answer.
        }
    }

    /**
     * Erase the outstanding work, which is what makes the agent idle. Runs on the caller's
     * context so it can be part of the transaction that settles the agent, letting a hook commit
     * its own conclusion of the run alongside the fact that the run is over.
     */
    async #clearPending(ctx: Context): Promise<void> {
        await this.#persistence.deleteValue(ctx, AGENT_BASE_PENDING_KEY);
        this.#pending = undefined;
        this.#pendingWritten = undefined;
    }

    /**
     * Queue a user message that injects as soon as the current assistant response and its tool
     * batch finish; steering always takes precedence over sent messages. Returns once the message
     * has been handed to the agent, which never waits for the turn that answers it; with
     * `await: true` it returns once the durable write has landed instead, and a failed write both
     * rejects and keeps the message out of the conversation entirely.
     */
    async steer(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        await this.#offer(ctx, "steering", message, options);
    }

    /**
     * Queue a user message that waits until the agent would otherwise stop — no tool calls or
     * steering remain — before injecting. Returns once the message has been handed to the agent,
     * which never waits for the turn that answers it; with `await: true` it returns once the
     * durable write has landed instead, and a failed write both rejects and keeps the message out
     * of the conversation entirely.
     */
    async send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void> {
        await this.#offer(ctx, "send", message, options);
    }

    /**
     * Hand one message to a durable queue. The acceptance runs whether or not the caller waits
     * for it — an unwaited failure is still a message that never entered the conversation, and
     * the agent's own close still drains it, so nothing is dropped by not looking.
     */
    async #offer(
        ctx: Context,
        kind: QueueRequest["kind"],
        message: SessionUserMessage,
        options: (AgentBaseMessageOptions & AgentBaseAwaitOptions) | undefined,
    ): Promise<void> {
        const { await: wait = false, ...settings } = options ?? {};
        // Refusing the flag rather than the operation: a closed agent and a re-entrant wait are
        // both caller mistakes, and both are reported before any work is started.
        this.#assertCanWait(
            ctx,
            wait,
            kind === "steering" ? "a steered message" : "a sent message",
        );
        if (this.#closed) throw new Error("The agent has been closed.");
        const accepted = this.#enqueue(ctx, [{ kind, message, options: settings }]);
        if (wait) return accepted;
        accepted.catch(() => undefined);
    }

    /**
     * Refuse a wait that could never end. A hook or a tool runs while its agent's loop waits for
     * it, so waiting for that same agent to finish anything is waiting for oneself; the request
     * itself is always allowed, and asking for another agent is unaffected.
     */
    #assertCanWait(ctx: Context, wait: boolean, operation: string): void {
        if (!wait) return;
        if (!insideTurn.get(ctx).includes(this.id)) return;
        throw new Error(
            `Waiting for ${operation} from inside the agent's own run loop would wait for a ` +
                "turn that cannot finish. Drop `await: true` to ask for it and return.",
        );
    }

    /**
     * Whether the current execution is running inside this agent's own run loop, judged by the
     * scope the loop marks itself with. This is what an operation carrying no context has to go
     * on. Anything that takes a context asks the context instead: it names the caller, where
     * this only describes what the loop happens to be running, and would mistake code the loop
     * called into for code the loop is waiting on.
     */
    #insideOwnLoop(): boolean {
        return insideLoops.getStore()?.includes(this.id) === true;
    }

    /**
     * Accept a batch of messages as one durable step. Every message is written under the same
     * hold of the persistence lock and inside one transaction, so a caller arriving while a
     * batch is being written lands after the whole batch rather than in the middle of it, and a
     * failure admits none of them.
     */
    async #enqueue(ctx: Context, batch: readonly QueueRequest[]): Promise<void> {
        if (batch.length === 0) return;
        if (this.#closed) throw new Error("The agent has been closed.");
        // Admitted: from here on the messages are the agent's responsibility, and a close that
        // begins now waits for them rather than resolving over the top of them.
        const admitted = this.#persistenceLock.runInLock(ctx, async (lockCtx) => {
            const accepted: { readonly key: string; readonly request: QueueRequest }[] = [];
            await this.#persistence.transaction(lockCtx, async (txCtx) => {
                for (const request of batch) {
                    const key = await this.#queueKey(txCtx, `${request.kind}.`);
                    await this.#persistence.writeValue(txCtx, key, {
                        message: request.message,
                        options: request.options,
                    });
                    accepted.push({ key, request });
                }
            });
            for (const { key, request } of accepted) {
                // The queue is resolved inside the lock: a history load running just before this
                // one replaces the queue arrays wholesale, and a reference taken before the wait
                // would push the message into an array nobody reads again.
                const queue = request.kind === "steering" ? this.#steering : this.#sends;
                queue.push({ key, message: request.message, options: request.options });
            }
            this.#turnRequested = true;
            this.#startRun();
        });
        this.#admitted.add(admitted);
        try {
            await admitted;
        } finally {
            this.#admitted.delete(admitted);
        }
    }

    /**
     * Start the loop without a new message: load the durable state and, if a turn was cut off —
     * queued messages, a dispatched tool batch without results, or an unanswered user or tool
     * message — continue it to completion. On an idle history this loads and does nothing more.
     */
    start(): void {
        if (this.#closed) throw new Error("The agent has been closed.");
        this.#startRun();
    }

    /**
     * Wait until the agent has nothing left to do. That includes work it has taken on but not yet
     * started: an operation whose caller did not wait for it is registered from the moment it is
     * called, so a message asked for and abandoned is still something this waits for, rather than
     * a race between the caller's next line and the agent's own lock.
     */
    async waitForIdle(): Promise<void> {
        while (this.#admitted.size > 0 || this.#runPromise !== undefined) {
            await Promise.allSettled([...this.#admitted]);
            await this.#runPromise;
        }
    }

    /**
     * Compact the conversation. The compaction waits for the active turn to end — or runs right
     * away when idle — and replaces the compacted history with the provider's replacement context
     * while keeping every message that joined the history after the snapshot.
     *
     * Returns once the compaction has been asked for; with `await: true` it returns once the
     * compaction has run, rejecting when the provider reports failure or when nothing will carry
     * it out. Callers that wait while a compaction is pending or running all wait for that same
     * compaction rather than queueing another.
     */
    async compact(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void> {
        const wait = options?.await ?? false;
        this.#assertCanWait(ctx, wait, "a compaction");
        if (this.#closed) throw new Error("The agent has been closed.");
        // A compaction runs between turns, so waiting for one waits for the target's current
        // turn to end. That is safe from an ordinary caller, and safe from another agent going
        // about its own business. It is not safe from inside a turn while the target is running
        // a tool: that tool may be waiting for this caller's agent, and neither side can see the
        // other half of the cycle. Such a request is refused outright rather than left standing,
        // because the caller asked to be told when the conversation had been replaced — and a
        // replacement carried out later, once nobody is waiting for it, is a different thing
        // from what was asked for. Ask again from a caller that can wait, or without the wait.
        if (wait && this.#toolsRunning > 0 && insideTurn.get(ctx).length > 0) {
            throw new Error(
                `Agent ${JSON.stringify(this.id)} is running a tool, so a compaction cannot be ` +
                    "waited for from inside another agent's turn: the two could be waiting for " +
                    "each other. Ask for it without `await: true`, or from outside a turn.",
            );
        }
        const compaction = this.#ensureCompaction();
        if (wait) return compaction;
        compaction.catch(() => undefined);
    }

    /**
     * End a compaction nobody will carry out. A compaction that already ran has settled its own
     * promise, so this only ever reaches one that was requested and then abandoned.
     */
    #settlePendingCompaction(reason: string): void {
        const pending = this.#compaction;
        if (pending === undefined) return;
        this.#compaction = undefined;
        pending.reject(new Error(reason));
    }

    /**
     * The pending compaction, requesting one if none is pending. Every caller shares the same
     * promise, and the request is what starts the loop that will carry it out.
     */
    #ensureCompaction(): Promise<void> {
        if (this.#compaction === undefined) {
            let resolve!: () => void;
            let reject!: (error: unknown) => void;
            const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            this.#compaction = { promise, resolve, reject };
            this.#turnRequested = true;
            this.#startRun();
        }
        return this.#compaction.promise;
    }

    /**
     * Track work that outlived the response it belonged to, so the next request can wait for it.
     * Failures are the unwinding work's own business and never reach the turn.
     */
    #settleLater(work: Promise<unknown>, kind: "stream" | "tool"): void {
        const tracked = work
            .catch(() => undefined)
            .finally(() => {
                this.#settling.delete(tracked);
                this.#streamCleanup.delete(tracked);
            });
        this.#settling.add(tracked);
        // A close waits for the stream to let go of the session before destroying it, but never
        // for a tool: a tool that ignores being abandoned would otherwise hold the shutdown open
        // for ever, and it may well be blocked on that very shutdown.
        if (kind === "stream") this.#streamCleanup.add(tracked);
    }

    /** Wait until no response iterator is still releasing the provider session. */
    async #streamsReleased(): Promise<void> {
        while (this.#streamCleanup.size > 0) {
            await Promise.allSettled([...this.#streamCleanup]);
        }
    }

    /** Wait until nothing from an earlier response is still holding the provider session. */
    async #settled(): Promise<void> {
        while (this.#settling.size > 0) {
            await Promise.allSettled([...this.#settling]);
        }
    }

    /**
     * The system prompt for the next request: the mutable state extended by the hook's answer.
     * Instructions and tools are correctness hooks — a failure here fails the turn loudly
     * instead of silently running with a wrong configuration.
     */
    async #instructions(): Promise<string> {
        const hooked = await this.#hooks.instructions?.(this.#ctx);
        return [this.state.instructions, hooked ?? ""]
            .filter((text) => text.length > 0)
            .join("\n\n");
    }

    /**
     * The tools for the next request or execution: the mutable state extended by the hook's
     * answer. Two tools sharing one name and namespace are a configuration error that fails
     * the turn, since the provider would receive ambiguous descriptors.
     */
    async #tools(): Promise<readonly AnyAgentTool[]> {
        const hooked = await this.#hooks.tools?.(this.#ctx);
        const tools = [...this.state.tools, ...(hooked ?? [])];
        const names = new Set<string>();
        for (const tool of tools) {
            const key = `${tool.namespace ?? ""}\u0000${tool.name}`;
            if (names.has(key)) {
                throw new Error(
                    tool.namespace === undefined
                        ? `Two tools are registered as "${tool.name}".`
                        : `Two tools are registered as "${tool.name}" in namespace "${tool.namespace}".`,
                );
            }
            names.add(key);
        }
        return tools;
    }

    /**
     * Cancel the active turn: stop consuming the inference stream, settle still-running tool calls
     * as aborted error results, and drop the queued turn request. Blocks that already finished
     * stay in the history; an unfinished block is dropped. Messages still waiting in the steering
     * and send queues stay durable and join the next requested turn. A no-op when the agent is
     * idle.
     *
     * Returns once the cancellation has been signalled, which is the point from which nothing
     * more of that turn happens; with `await: true` it returns once the loop has actually
     * unwound. The cancellation is identical either way — waiting only buys the answer about
     * when it finished.
     */
    async abort(ctx: Context, options?: AgentBaseAwaitOptions): Promise<void> {
        const wait = options?.await ?? false;
        this.#assertCanWait(ctx, wait, "an abort");
        const run = this.#signalAbort();
        if (run === undefined) return;
        // Dropping the turn request drops the only thing that would have carried out a
        // compaction asked for during it, so its callers are told rather than left waiting for
        // a turn that will never come. That happens once the loop has stopped, whether or not
        // anyone here is waiting to see it.
        if (wait) {
            await run;
            this.#settlePendingCompaction("The compaction was cancelled by an abort.");
            return;
        }
        void run
            .catch(() => undefined)
            .then(() => {
                this.#settlePendingCompaction("The compaction was cancelled by an abort.");
            });
    }

    /**
     * Signal cancellation of the active turn. Answers with the run to wait for, or undefined
     * when the agent was already idle and there was nothing to cancel.
     */
    #signalAbort(): Promise<void> | undefined {
        const run = this.#runPromise;
        if (run === undefined) return undefined;
        this.#turnRequested = false;
        this.#abortController?.abort();
        return run;
    }

    /**
     * Stop the agent, without abandoning anything it had already taken on. Nothing new is
     * admitted from the moment close is called, but a message accepted just before it is still
     * written, still answered, and only then is the provider session destroyed — so a caller
     * whose send resolved never has to wonder whether the close raced it. Closing twice awaits
     * the same shutdown.
     *
     * A close is nothing but a wait, so it is refused from inside the agent's own run loop, where
     * the wait could never end. It is the one operation with no context to check, so it asks the
     * runtime instead.
     *
     * Running tool calls are the exception to finishing what was accepted. From the moment close
     * begins, the batch stops waiting for them and settles them in the conversation as error
     * results. A tool can perfectly well be blocked on this very close — that is how two agents
     * closing each other through their tools would otherwise wedge — and no tool is worth
     * letting the shutdown never finish.
     */
    async close(): Promise<void> {
        // A close asked for from inside the loop is the one case that cannot cut the loop short,
        // because the work it would abandon is the caller itself.
        const fromInsideOwnLoop = this.#insideOwnLoop();
        this.#closed = true;
        if (!fromInsideOwnLoop) this.#closeController.abort();
        // The barrier is published before any of the shutdown runs. Destroying the provider
        // session can reenter close, and a caller arriving then has to join this shutdown rather
        // than start a second one that destroys the same session again.
        this.#closing ??= (async () => {
            await Promise.resolve();
            // Each admitted operation can still request a turn, and that turn can be the thing
            // that finishes the work, so both are drained until neither has anything left.
            while (this.#admitted.size > 0 || this.#runPromise !== undefined) {
                await Promise.allSettled([...this.#admitted]);
                await this.#runPromise?.catch(() => undefined);
            }
            this.#settlePendingCompaction("The agent was closed before the compaction ran.");
            // Close is the final ownership boundary for the provider session. A response
            // iterator that has not finished releasing it still holds it, and destroying it
            // underneath that cleanup hands the provider two owners at once.
            await this.#streamsReleased();
            await this.#session?.destroy();
            this.#session = undefined;
        })();
        if (!fromInsideOwnLoop) {
            await this.#closing;
            return;
        }
        // The caller is something the loop is waiting for. If the shutdown completes anyway the
        // caller had already let go and hears the truth; if it does not, the loop is still
        // waiting for this very caller, and saying so beats waiting for oneself for ever. The
        // shutdown itself continues regardless — it is the report that is given up on.
        const shutdown = this.#closing.then(
            () => true,
            () => true,
        );
        const settled = await Promise.race([
            shutdown,
            new Promise<false>((resolve) => {
                setTimeout(() => resolve(false), INSIDE_CLOSE_REPORT_MS).unref?.();
            }),
        ]);
        if (!settled) {
            throw new Error(
                "Closing the agent from inside its own run loop would wait for a turn that " +
                    "cannot finish. The shutdown was started and will complete once this " +
                    "caller returns.",
            );
        }
        await this.#closing;
    }

    /**
     * Make sure the run loop is running. A loop already in flight picks up the request on its
     * next pass, so this never starts a second one.
     */
    #startRun(): void {
        if (this.#runPromise !== undefined) return;
        // The loop is a lifetime of its own, so it marks itself rather than inheriting whatever
        // happened to start it — a tool of another agent, most often, which will be long gone.
        this.#runPromise = insideLoops
            .run([this.id], () => this.#runLoop())
            .finally(() => {
                this.#runPromise = undefined;
                // A request that arrived while the loop was settling would otherwise be stranded:
                // the loop had stopped checking, and the caller's own `#startRun` saw a run still
                // in flight. Waiters re-check the field, so they pick this continuation up.
                if (this.#turnRequested && !this.#closed) {
                    this.#startRun();
                    return;
                }
                this.#announceSettled();
            });
    }

    /**
     * Answer turns until nothing is asked for any more. The inner loop is one turn each: reload
     * the durable state, ask the pre-turn hooks what to do, run the inference and its tools, then
     * ask the post-turn hooks. The outer loop reopens when an `afterAgentLoop` action asks for
     * more work, so the loop hooks always bracket a settled-to-settled span.
     */
    async #runLoop(): Promise<void> {
        // The outer loop reopens when an `afterAgentLoop` action requests more work, so the
        // loop hooks always bracket a settled-to-settled span.
        do {
            // The abort scope opens before the loop hook, not just before the turn. An abort
            // owns everything the run does — its opening hook as much as its inference — so a
            // run cancelled while it is still starting up never reaches the model at all.
            let abort = this.#openAbortScope();
            // The agent is working from here, and says so durably before it does anything a
            // crash could interrupt. What it records is refined as the run reaches each stage;
            // what matters at this point is that the record exists at all, since its absence is
            // what a later process reads as an agent that finished.
            await this.#enterStage("inference");
            await this.#invokeHook(this.#hooks.beforeAgentLoop);
            do {
                this.#turnAborted = false;
                // Claimed before any awaiting, so a request raised while the turn is still
                // starting up survives into another turn instead of being cleared by it. The
                // redundant turn this can cost is cheap: an empty queue drains without any
                // inference.
                this.#turnRequested = false;
                // Every turn starts from the durable state rather than from what this instance
                // last remembered. Another owner over the same store may have appended messages
                // or changed the selection since, and answering out of a stale memory would
                // reply to a conversation that no longer exists.
                this.#loaded = undefined;
                // The durable history has to be loaded before the pre-turn hooks can be told
                // how large the conversation is; a failed load leaves them uninformed and the
                // turn itself reports the failure.
                await this.#ensureLoaded().catch(() => undefined);
                await this.#applyActions(this.#hooks.beforeTurn, abort.signal, {
                    contextTokens: this.#contextTokens,
                });
                await this.#runInference(abort);
                await this.#applyActions(this.#hooks.afterTurn, abort.signal, {
                    contextTokens: this.#contextTokens,
                    aborted: this.#turnAborted,
                });
                if (!this.#turnRequested || this.#closed) break;
                // Each turn cancels on its own scope. Reopening it here rather than at the top
                // keeps the run's first turn under the scope its opening hook already ran in.
                abort = this.#openAbortScope();
            } while (true);
            await this.#applyActions(this.#hooks.afterAgentLoop, abort.signal);
        } while (this.#turnRequested && !this.#closed);
        // Nothing is asked for any more, so the outstanding work is erased. That erasure is what
        // makes the agent idle, and it commits together with whatever the settling hooks write,
        // so no owner can ever see the agent finished without their conclusions or their
        // conclusions without the agent being finished.
        await this.#settleDurably();
    }

    /**
     * Erase the outstanding work and let the transactional settling hooks write in the same
     * transaction. A failure leaves the record in place: an agent wrongly believed to be working
     * is resumed and finds nothing to do, while one wrongly believed to be finished is never
     * resumed at all.
     */
    async #settleDurably(): Promise<void> {
        try {
            await this.#persistenceLock.runInLock(this.#ctx, (lockCtx) =>
                this.#persistence.transaction(lockCtx, async (txCtx) => {
                    await this.#clearPending(txCtx);
                    await this.#invokeTransactionalSettle(txCtx);
                }),
            );
        } catch {
            // The run itself is over and succeeded; only the record of its ending failed.
        }
    }

    /**
     * Call the settling hooks that write inside the settling transaction. They are lent a store
     * bound to that transaction — a capability taken back when they return, so it cannot be kept
     * and used to write outside the transaction it belongs to. A throwing hook rolls the
     * settlement back with it, because a hook here is writing a conclusion about the very fact
     * being committed, and half of that pair is worse than neither.
     */
    async #invokeTransactionalSettle(txCtx: Context): Promise<void> {
        const hook = this.#hooks.afterAgentSettledTransact;
        if (hook === undefined) return;
        const { kv, release } = this.#kv.locked(txCtx);
        try {
            await hook(withAgentKV(insideTurn.set(txCtx, []), kv));
        } finally {
            release();
        }
    }

    /**
     * Open the scope the next stretch of work is cancelled on, and make it the one an abort
     * signals. A cancellation that arrived before this point is not carried into the new scope:
     * it cancelled the work it was aimed at, and that work is over.
     */
    #openAbortScope(): AbortController {
        const abort = new AbortController();
        this.#abortController = abort;
        return abort;
    }

    /**
     * Commit and announce the settle, once the loop has actually stopped rather than as its last
     * act. The difference matters to whoever is listening: a hook told the agent has settled is
     * being told something it can act on, and asking for a compaction — or anything else the
     * loop carries out — has to reach a loop that can still be started.
     *
     * The work is admitted rather than left to run loose, so an idle agent is one whose settle
     * has finished, and a close waits for it like anything else it took on.
     */
    #announceSettled(): void {
        const announced = (async () => {
            // The settle runs once the loop has stopped, so its hook is not inside a turn and
            // its context does not claim to be: a compaction it waits for reaches a loop that
            // can still be started.
            await this.#invokeHookOn(insideTurn.set(this.#ctx, []), this.#hooks.afterAgentSettled);
        })();
        this.#admitted.add(announced);
        void announced.finally(() => this.#admitted.delete(announced));
    }

    /** Call an observing hook on the given context; a throwing hook is swallowed, never fatal. */
    async #invokeHookOn<Arguments extends readonly unknown[]>(
        ctx: Context,
        hook: ((ctx: Context, ...args: Arguments) => MaybePromise<void>) | undefined,
        ...args: Arguments
    ): Promise<void> {
        try {
            await hook?.(ctx, ...args);
        } catch {
            // Hooks observe the run; they never fail it.
        }
    }

    /** Call an observing hook on the agent's own context. */
    async #invokeHook<Arguments extends readonly unknown[]>(
        hook: ((ctx: Context, ...args: Arguments) => MaybePromise<void>) | undefined,
        ...args: Arguments
    ): Promise<void> {
        await this.#invokeHookOn(this.#ctx, hook, ...args);
    }

    /**
     * Ask a hook what to do next, on a scope that may be cancelled while the hook is still
     * thinking. An abort owns the whole of the turn it cancelled, including the answer of a hook
     * that was already running when it fired: carrying that answer out would open a fresh turn
     * out of work the caller had just cancelled. The answer is dropped rather than deferred,
     * since it was a decision about a turn that no longer exists.
     */
    async #applyActions<Arguments extends readonly unknown[]>(
        hook:
            | ((
                  ctx: Context,
                  ...args: Arguments
              ) => MaybePromise<readonly AgentFeatureAction[] | undefined>)
            | undefined,
        signal: AbortSignal,
        ...args: Arguments
    ): Promise<void> {
        if (hook === undefined) return;
        let actions: readonly AgentFeatureAction[] | undefined;
        try {
            actions = await hook(this.#ctx, ...args);
        } catch {
            return;
        }
        if (signal.aborted) return;
        await this.#carryOutActions(actions);
    }

    /**
     * Ask a lifecycle hook what to do next and carry its actions out: queue steering or sent
     * messages through the ordinary durable path, or trigger a compaction. Every returned
     * action is applied before the loop continues, so they all take effect at the same point.
     * Neither a throwing hook nor a failing action ever fails the run. Unlike `#applyActions`
     * this belongs to no turn's scope, so nothing can cancel the answer out from under it.
     */
    async #applyActionsAlways<Arguments extends readonly unknown[]>(
        hook:
            | ((
                  ctx: Context,
                  ...args: Arguments
              ) => MaybePromise<readonly AgentFeatureAction[] | undefined>)
            | undefined,
        ...args: Arguments
    ): Promise<void> {
        if (hook === undefined) return;
        let actions: readonly AgentFeatureAction[] | undefined;
        try {
            actions = await hook(this.#ctx, ...args);
        } catch {
            return;
        }
        await this.#carryOutActions(actions);
    }

    /**
     * Carry out what a hook asked for. The messages came from one decision, so they are accepted
     * as one batch: a caller arriving while they are being written lands after all of them
     * rather than between two halves of the same thought.
     */
    async #carryOutActions(actions: readonly AgentFeatureAction[] | undefined): Promise<void> {
        const batch: QueueRequest[] = [];
        const flush = async (): Promise<void> => {
            const pending = batch.splice(0, batch.length);
            try {
                await this.#enqueue(this.#ctx, pending);
            } catch {
                // A hook-driven action must not fail the run.
            }
        };
        for (const action of actions ?? []) {
            if (action.type === "compact") {
                await flush();
                this.#ensureCompaction().catch(() => undefined);
                continue;
            }
            batch.push({
                kind: action.type === "steer" ? "steering" : "send",
                message: action.message,
                options: {},
            });
        }
        await flush();
    }

    /**
     * One turn's work: resume an interrupted tool batch, run a requested compaction, then cycle
     * between draining the queues and asking the model, dispatching each response's tool calls,
     * until nothing is owed an answer. Every failure is caught here and surfaced to the
     * conversation, so a turn ends with a complete context whatever went wrong.
     */
    async #runInference(abort: AbortController): Promise<void> {
        // One shared promise for the turn's scope keeps races from piling up listeners on the
        // signal, and a scope that was aborted before this point settles it immediately: a
        // listener added afterwards would never hear the event that already happened.
        const abortPromise = abort.signal.aborted
            ? Promise.resolve(ABORTED)
            : new Promise<typeof ABORTED>((resolve) => {
                  abort.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
              });
        try {
            await this.#ensureLoaded();
            // Resume a tool batch that was dispatched but cut off before its results landed, so
            // the interrupted results reach the main store before any queued message.
            const resumed = this.#pendingTools;
            const undispatched = this.#pendingToolsUndispatched;
            this.#pendingTools = [];
            this.#pendingToolsUndispatched = false;
            if (resumed.length > 0) {
                // A batch that was never committed has certainly not run — the commit precedes
                // every execution — so it is dispatched as the fresh batch it never got to be,
                // rather than resumed, which would refuse the non-durable calls.
                if (await this.#runToolBatch(resumed, !undispatched, abort.signal, abortPromise)) {
                    return;
                }
            }
            // A requested compaction runs before this turn's first inference, so the model
            // always receives a settled conversation — never one still owing tool results.
            await this.#runCompaction(abort.signal);
            // An inference is needed without any injection when tool results from a resumed batch
            // end the context, or — checked once, against the freshly loaded durable state —
            // when a cut-off run left its trailing user or tool message unanswered. Afterwards
            // a trailing user message can be legitimate: a response may have zero blocks.
            let needsInference = resumed.length > 0;
            if (!this.#recoveryChecked) {
                this.#recoveryChecked = true;
                needsInference ||= this.#resumesInterruptedRun();
            }
            // Each cycle first drains the queues, then runs one inference. Steering injects at
            // every stop between responses and always outranks sends; sent messages inject
            // only when the agent would otherwise stop — no tool results or steering remain.
            // Queue consumption happens only here, between inferences, so an injected message
            // can never interleave with an active response's block records.
            // The message of an error response that has not been recovered from yet. A later
            // successful response clears it; a turn that ends while it is set has failed and
            // surfaces it to the context as a system message.
            let pendingError: string | undefined;
            while (true) {
                // An abort during the tool batch ends the turn here, before the next inference.
                // A cancellation arriving when the turn has nothing left to do cancels nothing:
                // the last response already reported its own terminal event, and a second one
                // would contradict it for the same response.
                if (abort.signal.aborted) {
                    const hasPendingWork =
                        needsInference || this.#steering.length > 0 || this.#sends.length > 0;
                    if (hasPendingWork) this.#emit({ type: "done", state: "cancelled" });
                    break;
                }
                let injected = await this.#consumeQueue(
                    this.#steering,
                    this.#steeringMode,
                    "steering.",
                );
                if (!injected && !needsInference) {
                    injected = await this.#consumeQueue(this.#sends, this.#sendMode, "send.");
                }
                // Nothing to answer — a start() on an idle history, or the queues ran dry.
                if (!injected && !needsInference) break;
                const instructions = await this.#instructions();
                const tools = await this.#tools();
                const session = await this.#ensureSession(instructions, tools);
                // Nothing from the previous response may still be holding the session — but
                // that unwinding was detached from an earlier abort precisely so it could never
                // hold a cancellation open, so a new cancellation must not start waiting for it
                // either.
                if ((await Promise.race([this.#settled(), abortPromise])) === ABORTED) continue;
                await this.#invokeHook(this.#hooks.beforeInference);
                const stream = session.run(this.#ctx, {
                    context: {
                        instructions,
                        messages: [...this.#messages],
                    },
                    ...(this.#model === undefined ? {} : { model: this.#model }),
                    ...(this.#effort === undefined ? {} : { effort: this.#effort }),
                    ...(this.#serviceTier === undefined ? {} : { serviceTier: this.#serviceTier }),
                });
                const { content, state, errorMessage, tokens } = await this.#collect(
                    stream,
                    abortPromise,
                );
                // A cancelled or failed response measures nothing, so the conversation keeps
                // the last real measurement instead of forgetting how large it had become.
                if (tokens !== undefined) {
                    await this.#recordContextTokens(tokens.input + tokens.output);
                }
                await this.#invokeHook(this.#hooks.afterInference, {
                    state,
                    tokens,
                    ...(errorMessage === undefined ? {} : { errorMessage }),
                });
                if (content.length > 0) {
                    this.#messages.push({ role: "assistant", content });
                }
                needsInference = false;
                pendingError = state === "error" ? errorMessage : undefined;
                if (state !== "tool_call") {
                    // A response can carry a tool call and still not end in one — a stream that
                    // failed or was cut off after the call was emitted. Nothing will dispatch
                    // it, so it is settled here rather than left in the conversation for ever.
                    await this.#settleUnansweredCalls(
                        "The response ended before this tool call was dispatched.",
                    );
                }
                if (state === "tool_call") {
                    const calls = content.filter(
                        (block): block is SessionToolCallBlock =>
                            block.type === "tool_call" && block.server !== true,
                    );
                    if (calls.length === 0) continue;
                    const conflict = conflictingCallId(calls);
                    if (conflict !== undefined) {
                        // Two different calls sharing one ID have no answer the model could tell
                        // apart — and neither would an error result, since it would be addressed
                        // to the same ambiguous ID. So nothing runs and nothing is answered: the
                        // turn fails loudly instead of inventing a reply to a question that has
                        // no unambiguous form. A call simply repeated verbatim is not ambiguous
                        // and is refused once, with a result, further down.
                        const message =
                            `Duplicate tool call id ${JSON.stringify(conflict)}: the response ` +
                            "used it for two different calls, so they could not be told apart. " +
                            "Neither ran.";
                        this.#emit({
                            type: "done",
                            state: "error",
                            kind: "internal_error",
                            message,
                        });
                        await this.#appendFailure(message);
                        break;
                    }
                    const closedDuringTools = await this.#runToolBatch(
                        toolBatchEntries(calls).map(({ call, rejected }, index) => ({
                            key: this.#toolKey(index, call.callId),
                            call,
                            ...(rejected === undefined ? {} : { rejected }),
                        })),
                        false,
                        abort.signal,
                        abortPromise,
                    );
                    if (closedDuringTools) break;
                    needsInference = true;
                    continue;
                }
                // A natural stop keeps draining, and so does a provider-reported error: the
                // failed response never answers the queued messages, so they still get their
                // fresh inference — each drain consumes from a finite queue, so a persistently
                // failing provider cannot loop. A cancellation or a stream that ended without
                // a done event ends the turn with the queues intact.
                if (state !== "normal" && state !== "length" && state !== "error") break;
            }
            if (pendingError !== undefined) {
                await this.#appendFailure(pendingError);
            }
        } catch (error: unknown) {
            this.#emit({
                type: "done",
                state: "error",
                kind: "internal_error",
                message: error instanceof Error ? error.message : String(error),
            });
            // A turn that failed while it owed tool results must not leave them owed: the next
            // message would be appended after an unanswered call, which most providers reject
            // outright and no later turn would ever repair.
            await this.#settleUnansweredCalls("The turn failed before this tool call finished.");
            await this.#appendFailure(error instanceof Error ? error.message : String(error));
        }
        this.#turnAborted = abort.signal.aborted;
    }

    /**
     * Whether this agent is picking up a run that was cut off rather than starting a fresh one,
     * and so owes an inference nobody asked for again.
     *
     * What is outstanding is read from the conversation: a tail that is a consumed message, a
     * tool result, or the note a failed turn left behind is owed an answer, while a replacement
     * written by a compaction is owed one only when the suffix it kept ends in a request.
     *
     * The pending record deliberately does not decide this, because one store may have several
     * live owners and there is only one record. An owner working right now leaves behind exactly
     * what a process that died would have left, so deciding from the record alone would have
     * each owner treat the others' work as abandoned and answer it a second time. What the
     * record adds is the knowledge that some run reached the model: a listener shown the
     * beginning of a block that will now never arrive is told to drop it. Only finished blocks
     * are ever persisted, so the conversation is intact and it is the view being corrected.
     */
    #resumesInterruptedRun(): boolean {
        const owed =
            this.#lastRecordType === "user" ||
            this.#lastRecordType === "tool" ||
            this.#lastRecordType === "system" ||
            // A replacement record is not a question in itself, however it happens to end — but
            // it keeps the suffix that joined the conversation after its snapshot, and a consumed
            // message in that suffix still needs inference. Which kind of message ends the
            // replacement is not visible in the messages, so the rewrite that knew records it.
            (this.#lastRecordType === "compaction" && this.#lastRecordContinuesInference);
        if (owed && this.#inherited?.stage === "inference") this.#emit({ type: "block_reset" });
        return owed;
    }

    /** Load the durable state once. A failed load is not sticky: the next turn retries it. */
    async #ensureLoaded(): Promise<void> {
        this.#loaded ??= this.#loadHistory().catch((error: unknown) => {
            this.#loaded = undefined;
            throw error;
        });
        await this.#loaded;
    }

    /**
     * Remember the conversation's true size, as the provider just measured it. The durable copy
     * lets a restarted agent keep knowing how large the conversation is without inferring it;
     * a failed write costs only that knowledge and never the response that produced it.
     */
    async #recordContextTokens(tokens: number | undefined): Promise<void> {
        this.#contextTokens = tokens;
        try {
            await this.#persistenceLock.runInLock(this.#ctx, (lockCtx) =>
                tokens === undefined
                    ? this.#persistence.deleteValue(lockCtx, "context")
                    : this.#persistence.writeValue(lockCtx, "context", { tokens }),
            );
        } catch {
            // A measurement is not worth failing a turn over; memory still carries it.
        }
    }

    /**
     * Run the pending compaction, if any. The snapshot is taken before the turn's first
     * inference, with this pass being the only history writer, so nothing joins the history
     * mid-compaction; the suffix copy still keeps any such message, defensively. The replacement
     * is appended as a compaction record — the load-time reset point — and settles the shared
     * promise for every caller awaiting it. A provider failure rejects them and leaves the
     * history untouched.
     */
    async #runCompaction(signal: AbortSignal): Promise<void> {
        const pending = this.#compaction;
        if (pending === undefined) return;
        try {
            await this.#enterStage("compaction");
            const instructions = await this.#instructions();
            const session = await this.#ensureSession(instructions, await this.#tools());
            // The snapshot is the durable conversation, counted as records: everything appended
            // after this point is a suffix the replacement has to keep, whoever wrote it. Taking
            // the boundary from the store rather than from this instance's own memory means a
            // record another owner committed while the provider was summarizing survives the
            // clear-and-replace instead of being erased by it.
            // The boundary is the prefix this instance's memory was built from, not whatever
            // the store holds now: the provider is about to summarize that memory, and counting
            // a newer store would describe records it never saw as summarized.
            const snapshotCount = this.#loadedRecordCount;
            const snapshot = [...this.#messages];
            await this.#settled();
            // Provider compaction is this turn's work, so it runs on this turn's lifetime: an
            // abort reaches the provider operation itself rather than waiting for it to finish
            // work nobody wants any more.
            const result = await session.compact(withLifetime(this.#ctx, signal), {
                context: { instructions, messages: snapshot },
                ...(this.#model === undefined ? {} : { model: this.#model }),
            });
            if (result.status === "failed") {
                throw new Error(result.message);
            }
            if (result.status === "completed") {
                await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
                    const records = await this.#persistence.load(lockCtx);
                    const suffix = messagesFromRecords(records.slice(snapshotCount));
                    const replaced = [...result.context.messages, ...suffix];
                    // Only a message in the live suffix can require another inference. The
                    // summary's own final message is provider-authored context, not a request.
                    const continuesInference = suffix.length > 0 && needsInference(replaced);
                    // Physically delete the superseded records and write the replacement —
                    // which keeps the messages that stay — in one atomic step.
                    await this.#recordTransaction(lockCtx, async (txCtx) => {
                        await this.#persistence.clearRecords(txCtx);
                        await this.#persistence.append(txCtx, {
                            type: "compaction",
                            messages: replaced,
                            ...(continuesInference ? { continuesInference: true } : {}),
                        });
                    });
                    this.#messages = [...replaced];
                    this.#lastRecordType = "compaction";
                    this.#lastRecordContinuesInference = continuesInference;
                    // The store is now the one replacement record, and memory is exactly it.
                    this.#loadedRecordCount = 1;
                });
                // The conversation the measurement described is gone; its size is unknown
                // again until the next response measures the replacement.
                await this.#recordContextTokens(undefined);
            }
            this.#compaction = undefined;
            pending.resolve();
        } catch (error: unknown) {
            this.#compaction = undefined;
            pending.reject(error);
        }
    }

    /**
     * Answer every call the last response left unanswered with an error result. The rule this
     * keeps is that the durable conversation never holds a tool call without its result: a call
     * is settled while it is still the last thing said, because a result appended after anything
     * else would sit in the wrong place and could not be repaired later.
     */
    async #settleUnansweredCalls(reason: string): Promise<void> {
        if (this.#loaded === undefined) return;
        const owed = this.#unansweredCalls(this.#messages);
        if (owed.length === 0) return;
        try {
            await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
                // A call the durable batch still holds belongs to the resume, which answers it
                // properly — and re-executes it when the tool is durable. Settling it here as
                // well would give the conversation two results for one call.
                const pending = await this.#persistence.readValues(lockCtx, "tool.");
                const dispatched = new Set(
                    pending.map(({ value }) => (value as SessionToolCallBlock).callId),
                );
                const results = owed
                    .filter((call) => !dispatched.has(call.callId))
                    .map((call) => toolFailure(call.callId, reason));
                if (results.length === 0) return;
                await this.#recordTransaction(lockCtx, async (txCtx) => {
                    for (const result of results) {
                        await this.#appendRecord(txCtx, { type: "tool", message: result });
                    }
                });
                this.#messages.push(...results);
            });
        } catch {
            // The turn is already failing; a restart settles what this could not.
        }
    }

    /**
     * Append one record and keep count of it. Every record this instance writes is one more that
     * its memory accounts for, and a rewrite has to know exactly where its own knowledge ends —
     * so appending and counting are one step rather than two a caller could get out of order.
     */
    async #appendRecord(ctx: Context, record: AgentBaseRecord): Promise<void> {
        await this.#persistence.append(ctx, record);
        this.#loadedRecordCount += 1;
    }

    /**
     * A transaction whose effect on the record count unwinds with it. Records staged by a
     * transaction that rolls back were never written, and memory never took them either, so the
     * count must not go on claiming them.
     */
    async #recordTransaction<Result>(
        ctx: Context,
        work: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        const counted = this.#loadedRecordCount;
        // The outstanding work unwinds with the records for the same reason: a stage staged by a
        // transaction that rolled back was never written, and memory claiming it would make the
        // agent skip the write that actually records what it is doing.
        const pending = this.#pending;
        const written = this.#pendingWritten;
        try {
            return await this.#persistence.transaction(ctx, work);
        } catch (error: unknown) {
            this.#loadedRecordCount = counted;
            this.#pending = pending;
            this.#pendingWritten = written;
            throw error;
        }
    }

    /**
     * Surface a failed turn to the conversation as a system message, so the next inference sees
     * what went wrong. Only unrecovered failures reach here — a later successful response in the
     * same turn clears its error without a trace. Skipped when the history never loaded, since
     * there is no context to append to; its own failure is swallowed, so surfacing a failure can
     * never cause another.
     */
    async #appendFailure(message: string): Promise<void> {
        if (this.#loaded === undefined) return;
        const failure: SessionSystemMessage = {
            role: "system",
            content: [{ type: "text", text: `The last turn failed: ${message}` }],
        };
        try {
            await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
                await this.#appendRecord(lockCtx, { type: "system", message: failure });
                this.#messages.push(failure);
            });
        } catch {
            // The turn already failed; a failing write must not escalate it.
        }
    }

    /**
     * Move the oldest queued message — or, in "all" mode, every queued message — into the main
     * context store and the in-memory history. The moves run in one transaction, so a message
     * is never durable in both stores or neither, and memory changes only after the commit.
     */
    async #consumeQueue(
        queue: QueueEntry[],
        mode: AgentBaseQueueMode,
        prefix: string,
    ): Promise<boolean> {
        return await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
            if (queue.length === 0) return false;
            // The durable queue, not memory, decides what is left to consume. Another owner over
            // the same store may have taken these entries already, and a message answered twice
            // is as wrong as one answered never.
            const durable = new Set(
                (await this.#persistence.readValues(lockCtx, prefix)).map(({ key }) => key),
            );
            const remaining = queue.filter((entry) => durable.has(entry.key));
            if (remaining.length !== queue.length) queue.splice(0, queue.length, ...remaining);
            if (queue.length === 0) return false;
            const count = mode === "all" ? queue.length : 1;
            const batch = queue.slice(0, count);
            // Settings carried by the consumed messages become the effective settings for the
            // inference that follows, each defined field superseding the previous value. The
            // effective values are persisted alongside the consumption so a restart keeps them.
            let provider = this.#providerId;
            let model = this.#model;
            let effort = this.#effort;
            let serviceTier = this.#serviceTier;
            let changed = false;
            for (const entry of batch) {
                if (entry.options.provider !== undefined) {
                    provider = entry.options.provider;
                    changed = true;
                }
                if (entry.options.model !== undefined) {
                    model = entry.options.model;
                    changed = true;
                }
                if (entry.options.effort !== undefined) {
                    effort = entry.options.effort;
                    changed = true;
                }
                if (entry.options.serviceTier !== undefined) {
                    serviceTier = entry.options.serviceTier;
                    changed = true;
                }
            }
            // A provider or model change is checked against the provider-model compatibility
            // matrix. An incompatible change resets the conversation: the history is erased
            // completely, the old provider session is destroyed, and the `modelChanged` hook
            // may inject one handoff system message at the very beginning of the fresh
            // context. A compatible provider change keeps the history but still gets a fresh
            // session, since a session is bound to the provider that created it.
            const selectionChanged = provider !== this.#providerId || model !== this.#model;
            let reset = false;
            let injected: SessionSystemMessage | undefined;
            if (selectionChanged) {
                if (this.#model !== undefined && model !== undefined) {
                    const previousType = this.#providers.typeOf(this.#providerId);
                    const nextType = this.#providers.typeOf(provider);
                    reset =
                        previousType === null ||
                        nextType === null ||
                        !areProviderModelsCompatible(
                            {
                                modelId: this.#model,
                                providerId: this.#providerId,
                                providerType: previousType,
                            },
                            {
                                modelId: model,
                                providerId: provider,
                                providerType: nextType,
                            },
                        );
                } else {
                    // A selection without a model on either side cannot be judged compatible.
                    reset = model !== this.#model;
                }
            }
            const consumed: QueueEntry[] = [];
            try {
                await this.#recordTransaction(lockCtx, async (txCtx) => {
                    if (selectionChanged) {
                        if (this.#hooks.modelChanged !== undefined && model !== undefined) {
                            // The hook runs while the persistence lock is held and inside the
                            // transaction that commits the switch, so its store executes directly on
                            // that transaction: what it writes lands and rolls back with the change
                            // it was told about, never on its own.
                            const locked = this.#kv.locked(txCtx);
                            const changeCtx = withAgentKV(
                                withAgentContext(this.#baseCtx, {
                                    id: this.id,
                                    provider,
                                    model,
                                    effort,
                                    serviceTier,
                                }),
                                locked.kv,
                            );
                            try {
                                injected = await this.#hooks.modelChanged(changeCtx, {
                                    previousModel: this.#model,
                                    model,
                                    previousProvider: this.#providerId,
                                    provider,
                                    providers: this.#providers,
                                    previousProviderInstance: this.#providers.get(this.#providerId),
                                    providerInstance: this.#providers.get(provider),
                                    wasReset: reset,
                                });
                            } catch {
                                // A failing handoff must not cost the conversation: an incompatible
                                // switch is rejected outright — the previous selection stays
                                // effective and the history is not cleared. A compatible change
                                // proceeds; the hook only observed it.
                                if (reset) {
                                    provider = this.#providerId;
                                    model = this.#model;
                                    reset = false;
                                }
                            } finally {
                                // The shortcut belonged to the hook's call, not to the hook.
                                locked.release();
                            }
                            if (!reset) injected = undefined;
                        }
                    }
                    consumed.length = 0;
                    // Each entry is claimed as it is consumed: the delete answers whether this
                    // owner is the one that took it, so a message shared by two live owners over
                    // one store is answered exactly once. Claiming first also means losing the
                    // whole batch rolls the transaction back before it has changed anything.
                    for (const entry of batch) {
                        const claimed = await this.#persistence.deleteValueIfPresent(
                            txCtx,
                            entry.key,
                        );
                        if (claimed) consumed.push(entry);
                    }
                    if (consumed.length === 0) throw LOST_QUEUE_RACE;
                    if (reset) {
                        await this.#persistence.clearRecords(txCtx);
                        this.#loadedRecordCount = 0;
                        // The erased conversation is what the measurement described.
                        await this.#persistence.deleteValue(txCtx, "context");
                        if (injected !== undefined) {
                            await this.#appendRecord(txCtx, {
                                type: "system",
                                message: injected,
                            });
                        }
                    }
                    for (const entry of consumed) {
                        await this.#appendRecord(txCtx, {
                            type: "user",
                            message: entry.message,
                        });
                    }
                    if (changed) {
                        await this.#persistence.writeValue(txCtx, "settings", {
                            provider,
                            ...(model === undefined ? {} : { model }),
                            ...(effort === undefined ? {} : { effort }),
                            ...(serviceTier === undefined ? {} : { serviceTier }),
                        });
                    }
                    // Consuming a message is precisely the act that makes an inference owed, so
                    // the two commit as one. A crash cannot land between them and leave a
                    // message in the conversation that nothing remembers having to answer.
                    await this.#recordPending(txCtx, { stage: "inference" });
                });
            } catch (error: unknown) {
                if (error !== LOST_QUEUE_RACE) throw error;
                // Another owner answered all of them. They are gone from the store, so they are
                // dropped from memory too, and this turn simply has nothing to inject.
                queue.splice(0, count);
                return false;
            }
            queue.splice(0, count);
            if (reset) {
                this.#messages = injected === undefined ? [] : [injected];
                this.#contextTokens = undefined;
            }
            if (reset || provider !== this.#providerId) {
                const session = this.#session;
                this.#session = undefined;
                try {
                    await session?.destroy();
                } catch {
                    // The change already committed; a failing destroy must not undo it.
                }
            }
            this.#messages.push(...consumed.map((entry) => entry.message));
            // This turn is answering the request that these messages raised. A send accepted
            // while the turn was already running raised it again, and letting that stand would
            // buy an extra turn with an empty queue and a full set of lifecycle hooks.
            if (
                this.#steering.length === 0 &&
                this.#sends.length === 0 &&
                this.#compaction === undefined
            ) {
                this.#turnRequested = false;
            }
            if (changed) {
                this.#providerId = provider;
                this.#model = model;
                this.#effort = effort;
                this.#serviceTier = serviceTier;
                this.#ctx = this.#deriveCtx();
            }
            return true;
        });
    }

    /**
     * Replace the in-memory state with the durable one. The persistence lock guarantees every
     * message already in memory reached storage first, so the load result supersedes memory
     * entirely: the main store rebuilds the context, and the sorted queue keys rebuild the
     * not-yet-consumed queues. Consecutive block records reassemble into one assistant message.
     */
    async #loadHistory(): Promise<void> {
        await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
            const records = await this.#persistence.load(lockCtx);
            const last = records[records.length - 1];
            this.#lastRecordType = last?.type;
            this.#lastRecordContinuesInference =
                last?.type === "compaction" && last.continuesInference === true;
            this.#loadedRecordCount = records.length;
            let restored = messagesFromRecords(records);
            const steering = await this.#persistence.readValues(lockCtx, "steering.");
            const sends = await this.#persistence.readValues(lockCtx, "send.");
            const pendingTools = await this.#persistence.readValues(lockCtx, "tool.");
            const settings = await this.#persistence.readValues(lockCtx, "settings");
            const context = await this.#persistence.readValues(lockCtx, "context");
            this.#messages = restored;
            // The measured size of the restored context, so the first turn after a reload can
            // still decide whether it needs a compaction.
            const measured = context[0]?.value as { readonly tokens: number } | undefined;
            this.#contextTokens = measured?.tokens;
            const entry = (key: string, value: unknown): QueueEntry => {
                const envelope = value as {
                    readonly message: SessionUserMessage;
                    readonly options?: AgentBaseMessageOptions;
                };
                return { key, message: envelope.message, options: envelope.options ?? {} };
            };
            this.#steering = steering.map(({ key, value }) => entry(key, value));
            this.#sends = sends.map(({ key, value }) => entry(key, value));
            // The persisted settings are the complete effective triple from the last change; an
            // absent field means that setting was effectively unset when it was written.
            const persisted = settings[0]?.value as AgentBaseMessageOptions | undefined;
            if (persisted !== undefined) {
                if (persisted.provider !== undefined) this.#providerId = persisted.provider;
                this.#model = persisted.model;
                this.#effort = persisted.effort;
                this.#serviceTier = persisted.serviceTier;
                this.#ctx = this.#deriveCtx();
            }
            this.#pendingTools = pendingTools.map(({ key, value }) => ({
                key,
                call: value as SessionToolCallBlock,
            }));
            this.#pendingToolsUndispatched = false;
            const dispatched = new Set(this.#pendingTools.map(({ call }) => call.callId));
            if (this.#pendingTools.length === 0) {
                // A crash between the response's last block and the batch commit leaves calls
                // the conversation still owes results for, with nothing durable to resume: the
                // context would keep an unanswered tool call for ever, which most providers
                // reject outright. They are recovered as the batch that was about to be
                // dispatched.
                const owed = this.#unansweredCalls(restored);
                if (owed.length > 0) {
                    this.#pendingTools = owed.map((call, index) => ({
                        key: this.#toolKey(index, call.callId),
                        call,
                    }));
                    this.#pendingToolsUndispatched = true;
                    for (const call of owed) dispatched.add(call.callId);
                }
            }
            // Anything still unanswered is stranded in the middle of the conversation: a turn
            // died before it could settle its calls, and the messages that followed made the
            // gap unreachable by appending. Repairing it means rewriting the conversation, so
            // it is written as the replacement record compaction already uses — atomically, and
            // only when something actually needs repairing.
            const repaired = repairUnansweredCalls(restored, dispatched);
            if (repaired !== undefined) {
                const snapshotCount = records.length;
                let replaced = repaired;
                await this.#recordTransaction(lockCtx, async (txCtx) => {
                    await this.#persistence.clearRecords(txCtx);
                    // The repair may replace only the snapshot it found the stranded call in.
                    // Anything another owner committed while this was being written is an
                    // authoritative suffix, so it is read here — after the deletion, which is
                    // the last point another owner could still have appended — and carried into
                    // the replacement rather than erased by it.
                    const current = await this.#persistence.load(txCtx);
                    replaced = [...repaired, ...messagesFromRecords(current.slice(snapshotCount))];
                    // A repair rewrites the real conversation rather than summarizing it, so
                    // what it ends on still has the same inference requirement after the rewrite.
                    await this.#persistence.append(txCtx, {
                        type: "compaction",
                        messages: replaced,
                        ...(needsInference(replaced) ? { continuesInference: true } : {}),
                    });
                });
                restored = replaced;
                this.#lastRecordType = "compaction";
                this.#lastRecordContinuesInference = needsInference(replaced);
                this.#loadedRecordCount = 1;
                this.#messages = [...replaced];
            }
        });
    }

    /**
     * Run one batch of tool calls. The whole batch is committed to the sorted store before any
     * call executes, so a crash mid-batch leaves a durable record of the calls still owed a
     * result. All calls run in parallel, but results land strictly in call order: a finished
     * result waits until every earlier call in the batch has committed, and each commit appends
     * the tool record and removes the pending entry in one transaction before memory changes.
     * On resume, only durable tools execute again; the rest become error results. An abort
     * settles every call still running as an aborted error result, so the batch always leaves a
     * complete context behind.
     */
    async #runToolBatch(
        entries: readonly ToolBatchEntry[],
        resume: boolean,
        signal: AbortSignal,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<boolean> {
        if (!resume) {
            await this.#persistenceLock.runInLock(this.#ctx, (lockCtx) =>
                this.#recordTransaction(lockCtx, async (txCtx) => {
                    for (const entry of entries) {
                        await this.#persistence.writeValue(txCtx, entry.key, entry.call);
                    }
                    // The batch and the stage that describes it commit together. A crash can
                    // then never find calls owed with no record of a run owing them, nor a run
                    // recorded as running tools that were never written.
                    await this.#recordPending(txCtx, { stage: "tools" });
                }),
            );
        } else {
            await this.#enterStage("tools");
        }
        const results: (SessionToolResultMessage | undefined)[] = new Array(entries.length);
        // Every execution actually started, whether or not its result reached the conversation.
        const running: Promise<SessionToolResultMessage>[] = [];
        let closedDuringTools = false;
        let committed = 0;
        // A failed commit ends the turn, and the turn records its own failure at the tail. A
        // sibling still running at that moment no longer owns the append-only tail: its result
        // would land behind the failure record, where no later turn could make sense of it. So
        // the first failed commit closes the batch to every result that was not committed yet.
        let commitFailed = false;
        const commitReady = async (): Promise<void> => {
            if (commitFailed) return;
            try {
                await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
                    while (committed < entries.length) {
                        const entry = entries[committed];
                        const result = results[committed];
                        if (entry === undefined || result === undefined) return;
                        await this.#recordTransaction(lockCtx, async (txCtx) => {
                            await this.#appendRecord(txCtx, {
                                type: "tool",
                                message: result,
                            });
                            // The call is answered, so what was kept only to let it be retried
                            // goes with it. What the tool itself wrote under its own call scope
                            // stays: that is the tool's state, not the batch's bookkeeping, and
                            // an owner may still want to read what a finished call recorded.
                            await this.#persistence.deleteValue(txCtx, entry.key);
                        });
                        this.#messages.push(result);
                        committed += 1;
                    }
                    // The batch is fully answered, so its results are what the model is owed a
                    // response to. Recording that here means a crash between the last result and
                    // the next request resumes as an inference rather than as a finished batch.
                    if (committed === entries.length) {
                        await this.#recordPending(lockCtx, { stage: "inference" });
                    }
                });
            } catch (error: unknown) {
                commitFailed = true;
                throw error;
            }
        };
        this.#toolsRunning += 1;
        const batch = Promise.all(
            entries.map(async (entry, index) => {
                let outcome: SessionToolResultMessage | typeof ABORTED;
                if (entry.rejected !== undefined) {
                    outcome = toolFailure(entry.call.callId, entry.rejected);
                } else if (resume && !(await this.#isDurable(entry.call))) {
                    outcome = toolFailure(
                        entry.call.callId,
                        "The tool call was interrupted by a restart and was not retried.",
                    );
                } else {
                    const execution = this.#executeToolCall(
                        withLifetime(this.#ctx, signal),
                        entry.call,
                    );
                    running.push(execution);
                    outcome = await Promise.race([execution, abortPromise, this.#closingTools()]);
                }
                if (outcome === ABORTED && !signal.aborted) closedDuringTools = true;
                results[index] =
                    outcome === ABORTED
                        ? {
                              role: "tool",
                              callId: entry.call.callId,
                              content: [
                                  {
                                      type: "text",
                                      text: signal.aborted
                                          ? "The tool call was aborted."
                                          : "The tool call was abandoned when the agent closed.",
                                  },
                              ],
                              isError: true,
                          }
                        : outcome;
                await commitReady();
            }),
        );
        try {
            await batch;
        } finally {
            this.#toolsRunning -= 1;
        }
        // An abort settles the call in the conversation, but it does not settle the call: the
        // tool is still running, and the session must not make its next request while that work
        // is in flight. The batch does not wait for it, so a tool that never notices the abort
        // cannot hold the turn open.
        this.#settleLater(Promise.allSettled(running), "tool");
        return closedDuringTools;
    }

    /**
     * Settles once close begins, so a batch stops waiting for tools that a shutdown may itself
     * be blocking. A close that has already begun settles it at once, since a listener added
     * afterwards would never hear the event that already happened.
     */
    #closingTools(): Promise<typeof ABORTED> {
        if (this.#closeController.signal.aborted) return Promise.resolve(ABORTED);
        return new Promise<typeof ABORTED>((resolve) => {
            this.#closeController.signal.addEventListener("abort", () => resolve(ABORTED), {
                once: true,
            });
        });
    }

    /** Whether this call's tool may safely be executed again after a restart interrupted it. */
    async #isDurable(call: SessionToolCallBlock): Promise<boolean> {
        const tool = (await this.#tools()).find(
            (candidate) => candidate.name === call.name && candidate.namespace === call.namespace,
        );
        return tool?.durable === true;
    }

    /**
     * The tool calls a restored conversation ends on without any results. Only a trailing
     * response can hold them: results are appended immediately after the batch that produced
     * them, so any earlier call is already settled.
     */
    #unansweredCalls(messages: readonly SessionMessage[]): SessionToolCallBlock[] {
        const last = messages[messages.length - 1];
        if (last?.role !== "assistant") return [];
        const calls = last.content.filter(
            (block): block is SessionToolCallBlock =>
                block.type === "tool_call" && block.server !== true,
        );
        return toolBatchEntries(calls).map(({ call }) => call);
    }

    /** Sorted by position in the batch; only one batch is ever pending at a time. */
    #toolKey(index: number, callId: string): string {
        return `tool.${String(index).padStart(6, "0")}.${callId}`;
    }

    /**
     * Run one tool call; every failure becomes an error tool result instead of an exception.
     * The context carries the turn's abort signal as its lifetime, so a running tool can
     * observe cancellation and stop its own work.
     */
    async #executeToolCall(
        ctx: Context,
        call: SessionToolCallBlock,
    ): Promise<SessionToolResultMessage> {
        const failure = (text: string): SessionToolResultMessage => ({
            role: "tool",
            callId: call.callId,
            content: [{ type: "text", text }],
            isError: true,
        });
        const tool = (await this.#tools()).find(
            (candidate) => candidate.name === call.name && candidate.namespace === call.namespace,
        );
        if (tool === undefined) {
            return failure(`Tool "${call.name}" is not available.`);
        }
        if (call.incomplete === true) {
            return failure("The tool call was incomplete and was not executed.");
        }
        let args: unknown;
        try {
            args = call.arguments.trim().length === 0 ? {} : JSON.parse(call.arguments);
        } catch {
            return failure(`The arguments for "${call.name}" were not valid JSON.`);
        }
        if (tool.parameters !== undefined && !Value.Check(tool.parameters, args)) {
            return failure(`The arguments for "${call.name}" did not match its schema.`);
        }
        try {
            // A tool execution persists under its own call ID, never in another call's scope.
            const callCtx = withAgentTaskContext(
                withAgentKV(ctx, this.#kv.scoped("call", call.callId)),
                taskContextBeforeToolCall(this.#messages, call.callId),
            );
            let executed: Promise<unknown> | undefined;
            const execute = (): Promise<unknown> =>
                (executed ??= Promise.resolve().then(
                    async () => await tool.execute(callCtx, args),
                ));
            const result: unknown =
                this.#hooks.aroundToolExecution === undefined
                    ? await execute()
                    : await this.#hooks.aroundToolExecution(callCtx, {
                          callId: call.callId,
                          tool,
                          arguments: args,
                          execute,
                      });
            if (!Value.Check(tool.returnType, result)) {
                return failure(`Tool "${call.name}" returned an invalid result.`);
            }
            const content = tool.toLLM(result);
            const isError = tool.isError?.(result) === true;
            return {
                role: "tool",
                callId: call.callId,
                content: [...content],
                ...(isError ? { isError: true } : {}),
            };
        } catch (error: unknown) {
            return failure(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * A key that sorts after every entry the queue already holds and belongs to no other
     * writer. The order comes from the store rather than from a counter this instance keeps,
     * because a restarted agent starts counting again and would otherwise reuse a key. The
     * trailing writer segment settles the rest: two owners that read the same tail at the same
     * millisecond still produce different keys, so an acknowledged message can never be
     * overwritten by one accepted elsewhere — only ordered arbitrarily against it, which is all
     * that simultaneous acceptance can mean. Reading the tail also keeps the order right when
     * the clock goes backwards.
     */
    async #queueKey(ctx: Context, prefix: string): Promise<string> {
        const existing = await this.#persistence.readValues(ctx, prefix);
        const last = existing[existing.length - 1]?.key;
        const time = String(Date.now()).padStart(14, "0");
        const key = (slot: string, sequence: number): string =>
            `${prefix}${slot}.${String(sequence).padStart(6, "0")}.${this.#writer}`;
        if (last === undefined) return key(time, 0);
        const [lastSlot, lastSequence] = last.slice(prefix.length).split(".");
        if (lastSlot === undefined || time > lastSlot) return key(time, 0);
        // The queue already holds an entry from this millisecond, or from one still to come on
        // a clock that went backwards: continue the sequence rather than starting it again.
        return key(lastSlot, Number(lastSequence) + 1);
    }

    /**
     * Consume one response stream into the assistant message it spells out, appending each block
     * to the store as it finishes and reporting every event to the hooks. What comes back is what
     * the model actually finished saying: a response cut off mid-block keeps the finished blocks
     * alone, so memory never differs from what a reload would rebuild.
     */
    async #collect(
        stream: AsyncIterable<SessionEvent>,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<{
        readonly content: SessionAssistantBlock[];
        readonly state: SessionDoneState | undefined;
        /** Reported only by a response that completed; a cancelled or failed one measures none. */
        readonly tokens?: SessionTokens;
        readonly errorMessage?: string;
    }> {
        const content: SessionAssistantBlock[] = [];
        // Blocks that finished and were durably appended. An abort keeps exactly these, so the
        // in-memory assistant message never diverges from what a reload would rebuild.
        const persisted: SessionAssistantBlock[] = [];
        const toolCallIndexes = new Map<string, number>();
        const persist = async (block: SessionAssistantBlock | undefined): Promise<void> => {
            if (block === undefined) return;
            await this.#persistenceLock.runInLock(this.#ctx, (lockCtx) =>
                this.#appendRecord(lockCtx, { type: "block", block }),
            );
            persisted.push(block);
        };
        const iterator = stream[Symbol.asyncIterator]();
        // A response usually ends before its stream does — at the done event, or at an abort —
        // and the provider holds a connection behind that stream. Whichever way this method
        // leaves, an unfinished stream is asked to close, so nothing is left dangling. The
        // closure is not awaited: a provider that stalls while cleaning up must not stall the
        // turn, exactly as an abort must not wait for it either.
        let exhausted = false;
        try {
            while (true) {
                const next = await Promise.race([iterator.next(), abortPromise]);
                if (next === ABORTED) {
                    // Drop the unfinished block and end the turn.
                    this.#emit({ type: "done", state: "cancelled" });
                    return { content: persisted, state: "cancelled" };
                }
                if (next.done === true) {
                    exhausted = true;
                    break;
                }
                const event = next.value;
                this.#emit(event);
                switch (event.type) {
                    case "text_start":
                        content.push({ type: "text", text: "" });
                        break;
                    case "text_delta": {
                        const last = content[content.length - 1];
                        if (last?.type === "text") {
                            content[content.length - 1] = {
                                type: "text",
                                text: last.text + event.delta,
                            };
                        }
                        break;
                    }
                    case "text_end": {
                        const last = content[content.length - 1];
                        await persist(last?.type === "text" ? last : undefined);
                        break;
                    }
                    case "reasoning_start":
                        content.push({ type: "reasoning", text: "" });
                        break;
                    case "reasoning_delta": {
                        const last = content[content.length - 1];
                        if (last?.type === "reasoning") {
                            content[content.length - 1] = {
                                ...last,
                                text: (last.text ?? "") + event.delta,
                            };
                        }
                        break;
                    }
                    case "reasoning_end": {
                        const last = content[content.length - 1];
                        if (last?.type === "reasoning") {
                            const finished = {
                                ...last,
                                ...(event.reasoning === undefined
                                    ? {}
                                    : { reasoning: event.reasoning }),
                            };
                            content[content.length - 1] = finished;
                            await persist(finished);
                        }
                        break;
                    }
                    case "toolcall_start":
                        toolCallIndexes.set(event.callId, content.length);
                        content.push({
                            type: "tool_call",
                            callId: event.callId,
                            name: event.name,
                            arguments: "",
                            ...(event.namespace === undefined
                                ? {}
                                : { namespace: event.namespace }),
                            ...(event.server === undefined ? {} : { server: event.server }),
                            ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
                        });
                        break;
                    case "toolcall_end": {
                        const index = toolCallIndexes.get(event.callId);
                        const block = index === undefined ? undefined : content[index];
                        if (index !== undefined && block?.type === "tool_call") {
                            const finished = {
                                ...block,
                                arguments: event.arguments,
                                ...(event.incomplete === undefined
                                    ? {}
                                    : { incomplete: event.incomplete }),
                            };
                            content[index] = finished;
                            await persist(finished);
                        }
                        break;
                    }
                    // The provider settled a server tool call on its own backend and streams the
                    // result here. The agent simply ignores it: nothing to execute, nothing to
                    // store — the events still reach the hooks like every other event.
                    case "toolcall_result_start":
                    case "toolcall_result_delta":
                    case "toolcall_result_end":
                        break;
                    case "done":
                        return {
                            // Only blocks that finished, which are exactly the blocks that were
                            // durably appended. A response ending mid-block leaves half of
                            // something the model never finished saying, and keeping that in
                            // memory alone would make the next live request differ from the one
                            // a restart would rebuild from the store.
                            content: persisted,
                            state: event.state,
                            ...(event.state === "error" ? { errorMessage: event.message } : {}),
                            ...(event.state === "normal" ||
                            event.state === "tool_call" ||
                            event.state === "length"
                                ? { tokens: event.tokens }
                                : {}),
                        };
                    default:
                        break;
                }
            }
            return { content, state: undefined };
        } finally {
            // A done event ends the response, not the provider's ownership of its session. The
            // closure is requested here and waited for before the next request, rather than
            // now: a stream that has been told to stop and has not yet must not be able to hold
            // this turn — or an abort — open.
            if (!exhausted) {
                this.#settleLater(Promise.resolve(iterator.return?.()), "stream");
            }
        }
    }

    /**
     * Create the provider session on first use — or recreate it when the provider-facing
     * configuration changed, so the model always sees the tool descriptors the agent would
     * actually execute. The provider is resolved from the registry by its serializable ID at
     * that moment; an unregistered ID fails the turn like any thrown error.
     */
    async #ensureSession(
        instructions: string,
        tools: readonly AnyAgentTool[],
    ): Promise<BaseSession> {
        const key = sessionConfigKey(instructions, tools);
        if (this.#session !== undefined && this.#sessionConfig !== key) {
            const session = this.#session;
            this.#session = undefined;
            // The session being replaced may still be held by a response iterator that has not
            // finished unwinding. Destroying it first would tear it out from under that cleanup.
            await this.#settled();
            try {
                await session.destroy();
            } catch {
                // The stale session is abandoned either way.
            }
        }
        if (this.#session === undefined) {
            const provider = this.#providers.get(this.#providerId);
            if (provider === null) {
                throw new Error(`Provider "${this.#providerId}" is not registered.`);
            }
            this.#session = await provider.session(this.id, {
                instructions,
                tools: [...tools],
            });
            this.#sessionConfig = key;
        }
        return this.#session;
    }

    /** Report one stream event to the hooks. Hooks observe the stream; they never fail a run. */
    #emit(event: SessionEvent): void {
        try {
            this.#hooks.onEvent?.(this.#ctx, event);
        } catch {
            // Hooks observe the stream; they never fail a run.
        }
    }
}

/** Whether a conversation ends on something the model has not answered. */
function needsInference(messages: readonly SessionMessage[]): boolean {
    const last = messages[messages.length - 1];
    return last?.role === "user" || last?.role === "tool" || last?.role === "system";
}

/**
 * The conversation a run of records spells out. A compaction record carries the complete
 * replacement context and supersedes everything before it; consecutive blocks belong to one
 * response. Used both to restore the whole history and to read the tail of it, which is why it
 * takes any run of records rather than the store itself.
 */
function messagesFromRecords(records: readonly AgentBaseRecord[]): SessionMessage[] {
    let messages: SessionMessage[] = [];
    for (const record of records) {
        if (record.type === "compaction") {
            messages = [...record.messages];
            continue;
        }
        if (record.type === "user" || record.type === "tool" || record.type === "system") {
            messages.push(record.message);
            continue;
        }
        const last = messages[messages.length - 1];
        if (last?.role === "assistant") {
            messages[messages.length - 1] = {
                role: "assistant",
                content: [...last.content, record.block],
            };
        } else {
            messages.push({ role: "assistant", content: [record.block] });
        }
    }
    return messages;
}

/** The result that stands in for a call the agent could not, or must not, carry out. */
function toolFailure(callId: string, reason: string): SessionToolResultMessage {
    return {
        role: "tool",
        callId,
        content: [{ type: "text", text: reason }],
        isError: true,
    };
}

/**
 * Insert an error result for every call the conversation never answered, immediately after the
 * response that made it, and return the repaired conversation — or undefined when there is
 * nothing to repair, which is the ordinary case. Calls the caller is about to run or resume are
 * exempt: they are going to be answered properly.
 */
function repairUnansweredCalls(
    messages: readonly SessionMessage[],
    exempt: ReadonlySet<string>,
): SessionMessage[] | undefined {
    const answered = new Set(
        messages.flatMap((message) => (message.role === "tool" ? [message.callId] : [])),
    );
    const repaired: SessionMessage[] = [];
    let changed = false;
    for (const message of messages) {
        repaired.push(message);
        if (message.role !== "assistant") continue;
        for (const block of message.content) {
            if (block.type !== "tool_call" || block.server === true) continue;
            if (answered.has(block.callId) || exempt.has(block.callId)) continue;
            // One answer per call ID, even when a response repeated one: a second result for
            // the same ID would be as unmatchable as the duplicate call that caused it.
            answered.add(block.callId);
            repaired.push(
                toolFailure(
                    block.callId,
                    "The turn ended before this tool call could be answered.",
                ),
            );
            changed = true;
        }
    }
    return changed ? repaired : undefined;
}

/**
 * The provider-facing identity of a session configuration. Only descriptor fields the provider
 * sees participate, so re-created tool objects with identical descriptors do not churn the
 * session.
 */
function sessionConfigKey(instructions: string, tools: readonly AnyAgentTool[]): string {
    return deterministicStringify([
        instructions,
        tools.map((tool) => [
            tool.name,
            tool.namespace ?? null,
            tool.namespaceDescription ?? null,
            tool.description ?? null,
            tool.parameters ?? null,
            tool.defer ?? null,
            tool.server ?? null,
            tool.grammar ?? null,
        ]),
    ]);
}

/**
 * The first call ID a response used for two calls that are not the same call. Repeating one
 * identical call under one ID says nothing new — it is the same request twice, and answering it
 * once answers it. Two different calls under one ID are a genuine ambiguity: whatever result the
 * conversation carried back would be addressed to both of them.
 */
function conflictingCallId(calls: readonly SessionToolCallBlock[]): string | undefined {
    const seen = new Map<string, string>();
    for (const call of calls) {
        const shape = deterministicStringify([
            call.name,
            call.namespace ?? null,
            call.arguments,
            call.incomplete ?? null,
        ]);
        const previous = seen.get(call.callId);
        if (previous !== undefined && previous !== shape) return call.callId;
        seen.set(call.callId, shape);
    }
    return undefined;
}

/**
 * The calls of one response, reduced to one entry per call ID. A response is allowed to run
 * several tools at once, but only if the model can tell their answers apart: results are matched
 * back by call ID, and two calls sharing one ID have no distinguishable answer. Rather than
 * execute side effects whose results the conversation cannot describe, such a call ID is kept
 * once and refused — before anything runs, since a refusal after the fact would not undo it.
 */
function toolBatchEntries(
    calls: readonly SessionToolCallBlock[],
): readonly { readonly call: SessionToolCallBlock; readonly rejected?: string }[] {
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call.callId, (counts.get(call.callId) ?? 0) + 1);
    const taken = new Set<string>();
    const entries: { readonly call: SessionToolCallBlock; readonly rejected?: string }[] = [];
    for (const call of calls) {
        if (taken.has(call.callId)) continue;
        taken.add(call.callId);
        entries.push(
            (counts.get(call.callId) ?? 0) > 1
                ? {
                      call,
                      rejected:
                          "The response used this tool call ID more than once, so the calls " +
                          "could not be told apart and none of them ran.",
                  }
                : { call },
        );
    }
    return entries;
}
