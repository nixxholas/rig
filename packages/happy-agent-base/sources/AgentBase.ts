import type {
    BaseSession,
    SessionAssistantBlock,
    SessionDoneState,
    SessionEvent,
    SessionMessage,
    SessionReasoningEffort,
    SessionServiceTier,
    SessionSystemMessage,
    SessionToolCallBlock,
    SessionToolResultMessage,
    SessionUserMessage,
} from "@slopus/happy-providers";
import { areProviderModelsCompatible } from "@slopus/happy-providers";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, withLifetime, type AsyncLock, type Context } from "@steve.kite/stdlib";

import { withAgentBaseContext } from "./AgentBaseContext.js";
import type { AgentBaseHooks } from "./AgentBaseHooks.js";
import type { AgentBasePersistence } from "./AgentBasePersistence.js";
import type { AgentBaseState } from "./AgentBaseState.js";
import { AgentProviders } from "./AgentProviders.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

/** Race winner when an abort interrupts a wait on the stream or a running tool. */
const ABORTED = Symbol("aborted");

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
    readonly model?: string;
    readonly effort?: SessionReasoningEffort;
    readonly serviceTier?: SessionServiceTier;
}

/** A durably queued message together with the settings it carries. */
interface QueueEntry {
    readonly key: string;
    readonly message: SessionUserMessage;
    readonly options: AgentBaseMessageOptions;
}

export interface AgentBaseOptions {
    /** Stable session identity supplied by the caller. */
    readonly id: string;
    /** The registry providers are resolved from, at session creation time. */
    readonly providers: AgentProviders;
    /** The registry ID of the provider to use; serializable alongside model and effort. */
    readonly provider: string;
    readonly persistence: AgentBasePersistence;
    readonly hooks?: AgentBaseHooks;
    /** Copied into the agent's own mutable `state`. */
    readonly initialState?: Partial<AgentBaseState>;
    readonly model?: string;
    readonly effort?: SessionReasoningEffort;
    readonly serviceTier?: SessionServiceTier;
    readonly steeringMode?: AgentBaseQueueMode;
    readonly sendMode?: AgentBaseQueueMode;
}

/**
 * A single agent session over one provider. Messages arrive through two FIFO queues: steering
 * messages inject as soon as the current assistant response and its tool batch finish, while
 * sent messages wait until the agent would otherwise stop — no tool calls or steering remain.
 * Each queue drains per its configured mode, and the conversation is durable through
 * append-only persistence loaded on the first inference attempt.
 */
export class AgentBase {
    readonly id: string;
    /**
     * The agent's own copy of the initial state, mutable directly; every inference reads the
     * current values.
     */
    readonly state: AgentBaseState;

    readonly #baseCtx: Context;
    #ctx: Context;
    readonly #providers: AgentProviders;
    #providerId: string;
    readonly #persistence: AgentBasePersistence;
    #model: string | undefined;
    #effort: SessionReasoningEffort | undefined;
    #serviceTier: SessionServiceTier | undefined;
    readonly #hooks: AgentBaseHooks;
    /**
     * Serializes every persistence operation together with its in-memory effect, so storage
     * order always matches history order and a load never overlaps an append.
     */
    readonly #persistenceLock: AsyncLock = asyncLock({ reentry: "block" });

    readonly #steeringMode: AgentBaseQueueMode;
    readonly #sendMode: AgentBaseQueueMode;

    #session: BaseSession | undefined;
    #messages: SessionMessage[] = [];
    #steering: QueueEntry[] = [];
    #sends: QueueEntry[] = [];
    #pendingTools: { readonly key: string; readonly call: SessionToolCallBlock }[] = [];
    #pendingSequence = 0;
    #loaded: Promise<void> | undefined;
    #recoveryChecked = false;
    #compaction:
        | {
              readonly promise: Promise<void>;
              readonly resolve: () => void;
              readonly reject: (error: unknown) => void;
          }
        | undefined;
    #abortController: AbortController | undefined;
    #turnRequested = false;
    #runPromise: Promise<void> | undefined;
    #closed = false;

    constructor(ctx: Context, options: AgentBaseOptions) {
        this.id = options.id;
        this.#baseCtx = ctx;
        this.#providers = options.providers;
        this.#providerId = options.provider;
        this.#persistence = options.persistence;
        this.#hooks = options.hooks ?? {};
        this.state = {
            instructions: options.initialState?.instructions ?? "",
            tools: [...(options.initialState?.tools ?? [])],
        };
        this.#model = options.model;
        this.#effort = options.effort;
        this.#serviceTier = options.serviceTier;
        // Everything the agent does — hooks and tool executions included — runs on a context
        // carrying its provider and the currently effective model, effort, and service tier.
        this.#ctx = this.#deriveCtx();
        this.#steeringMode = options.steeringMode ?? "one-at-a-time";
        this.#sendMode = options.sendMode ?? "one-at-a-time";
    }

    #deriveCtx(): Context {
        return withAgentBaseContext(this.#baseCtx, {
            provider: this.#providerId,
            model: this.#model,
            effort: this.#effort,
            serviceTier: this.#serviceTier,
        });
    }

    /**
     * Queue a user message that injects as soon as the current assistant response and its tool
     * batch finish; steering always takes precedence over sent messages. The returned promise
     * resolves once the durable write lands; it waits neither for the history load nor for the
     * turn, and a failed write keeps the message out of the conversation entirely.
     */
    async steer(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#enqueue(ctx, "steering.", this.#steering, message, options ?? {});
    }

    /**
     * Queue a user message that waits until the agent would otherwise stop — no tool calls or
     * steering remain — before injecting. The returned promise resolves once the durable write
     * lands; it waits neither for the history load nor for the turn, and a failed write keeps
     * the message out of the conversation entirely.
     */
    async send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#enqueue(ctx, "send.", this.#sends, message, options ?? {});
    }

    async #enqueue(
        ctx: Context,
        prefix: string,
        queue: QueueEntry[],
        message: SessionUserMessage,
        options: AgentBaseMessageOptions,
    ): Promise<void> {
        if (this.#closed) throw new Error("The agent has been closed.");
        await this.#persistenceLock.runInLock(ctx, async (lockCtx) => {
            const key = this.#queueKey(prefix);
            await this.#persistence.writeValue(lockCtx, key, { message, options });
            queue.push({ key, message, options });
            this.#turnRequested = true;
            this.#startRun();
        });
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

    async waitForIdle(): Promise<void> {
        while (this.#runPromise !== undefined) {
            await this.#runPromise;
        }
    }

    /**
     * Compact the conversation. The compaction waits for the active turn to end — or runs right
     * away when idle — and replaces the compacted history with the provider's replacement
     * context while keeping every message that joined the history after the snapshot. Calls made
     * while a compaction is pending or running await that same compaction; the shared promise
     * resolves when it completes and rejects when the provider reports failure.
     */
    async compact(ctx: Context): Promise<void> {
        if (this.#closed) throw new Error("The agent has been closed.");
        return this.#ensureCompaction();
    }

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
     * The system prompt for the next request: the hook's answer when one is provided, the
     * mutable state otherwise. A throwing hook falls back to the state; it never fails the run.
     */
    #instructions(): string {
        try {
            return this.#hooks.instructions?.(this.#ctx) ?? this.state.instructions;
        } catch {
            return this.state.instructions;
        }
    }

    /**
     * The tools for the next request or execution: the hook's answer when one is provided, the
     * mutable state otherwise. A throwing hook falls back to the state; it never fails the run.
     */
    #tools(): readonly AnyAgentTool[] {
        try {
            return this.#hooks.tools?.(this.#ctx) ?? this.state.tools;
        } catch {
            return this.state.tools;
        }
    }

    /**
     * Cancel the active turn: stop consuming the inference stream, settle still-running tool
     * calls as aborted error results, and drop the queued turn request. Blocks that already
     * finished stay in the history; an unfinished block is dropped. Messages still waiting in
     * the steering and send queues stay durable and join the next requested turn. Resolves
     * once the loop has stopped; a no-op when the agent is idle.
     */
    async abort(): Promise<void> {
        const run = this.#runPromise;
        if (run === undefined) return;
        this.#turnRequested = false;
        this.#abortController?.abort();
        await run;
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        await this.#runPromise;
        await this.#session?.destroy();
        this.#session = undefined;
    }

    #startRun(): void {
        if (this.#runPromise !== undefined) return;
        this.#runPromise = this.#runLoop().finally(() => {
            this.#runPromise = undefined;
        });
    }

    async #runLoop(): Promise<void> {
        // The outer loop reopens when an `afterAgentLoop` action requests more work, so the
        // loop hooks always bracket a settled-to-settled span.
        do {
            this.#invokeHook(this.#hooks.beforeAgentLoop);
            do {
                this.#turnRequested = false;
                this.#invokeHook(this.#hooks.beforeTurn);
                await this.#runInference();
                await this.#applyActions(this.#hooks.afterTurn);
            } while (this.#turnRequested && !this.#closed);
            await this.#applyActions(this.#hooks.afterAgentLoop);
        } while (this.#turnRequested && !this.#closed);
    }

    #invokeHook(hook: ((ctx: Context) => void) | undefined): void {
        try {
            hook?.(this.#ctx);
        } catch {
            // Hooks observe the run; they never fail it.
        }
    }

    /**
     * Ask a lifecycle hook what to do next and carry its actions out: queue steering or sent
     * messages through the ordinary durable path, or trigger a compaction. Every returned
     * action is applied before the loop continues, so they all take effect at the same point.
     * Neither a throwing hook nor a failing action ever fails the run.
     */
    async #applyActions(
        hook: ((ctx: Context) => readonly AgentFeatureAction[] | undefined) | undefined,
    ): Promise<void> {
        if (hook === undefined) return;
        let actions: readonly AgentFeatureAction[] | undefined;
        try {
            actions = hook(this.#ctx);
        } catch {
            return;
        }
        for (const action of actions ?? []) {
            try {
                if (action.type === "compact") {
                    this.#ensureCompaction().catch(() => undefined);
                    continue;
                }
                const queue = action.type === "steer" ? this.#steering : this.#sends;
                const prefix = action.type === "steer" ? "steering." : "send.";
                await this.#enqueue(this.#ctx, prefix, queue, action.message, {});
            } catch {
                // A hook-driven action must not fail the run.
            }
        }
    }

    async #runInference(): Promise<void> {
        // One abort scope per pass; a single shared promise keeps races from piling up
        // listeners on the signal.
        const abort = new AbortController();
        this.#abortController = abort;
        const abortPromise = new Promise<typeof ABORTED>((resolve) => {
            abort.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
        });
        try {
            // A failed load is not sticky: the cache resets so the next turn retries it.
            this.#loaded ??= this.#loadHistory().catch((error: unknown) => {
                this.#loaded = undefined;
                throw error;
            });
            await this.#loaded;
            // Resume a tool batch that was dispatched but cut off before its results landed, so
            // the interrupted results reach the main store before any queued message.
            const resumed = this.#pendingTools;
            this.#pendingTools = [];
            if (resumed.length > 0) {
                await this.#runToolBatch(resumed, true, abort.signal, abortPromise);
            }
            // A response is owed without any injection when tool results from a resumed batch
            // end the context, or — checked once, against the freshly loaded durable state —
            // when a cut-off run left its trailing user or tool message unanswered. Afterwards
            // a trailing user message can be legitimate: a response may have zero blocks.
            let responseOwed = resumed.length > 0;
            if (!this.#recoveryChecked) {
                this.#recoveryChecked = true;
                const last = this.#messages[this.#messages.length - 1];
                responseOwed ||= last?.role === "user" || last?.role === "tool";
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
                if (abort.signal.aborted) {
                    this.#emit({ type: "done", state: "cancelled" });
                    break;
                }
                let injected = await this.#consumeQueue(this.#steering, this.#steeringMode);
                if (!injected && !responseOwed) {
                    injected = await this.#consumeQueue(this.#sends, this.#sendMode);
                }
                // Nothing to answer — a start() on an idle history, or the queues ran dry.
                if (!injected && !responseOwed) break;
                const session = await this.#ensureSession();
                this.#invokeHook(this.#hooks.beforeInference);
                const stream = session.run(this.#ctx, {
                    context: {
                        instructions: this.#instructions(),
                        messages: [...this.#messages],
                    },
                    ...(this.#model === undefined ? {} : { model: this.#model }),
                    ...(this.#effort === undefined ? {} : { effort: this.#effort }),
                    ...(this.#serviceTier === undefined
                        ? {}
                        : { serviceTier: this.#serviceTier }),
                });
                const { content, state, errorMessage } = await this.#collect(
                    stream,
                    abortPromise,
                );
                this.#invokeHook(this.#hooks.afterInference);
                if (content.length > 0) {
                    this.#messages.push({ role: "assistant", content });
                }
                responseOwed = false;
                pendingError = state === "error" ? errorMessage : undefined;
                if (state === "tool_call") {
                    const calls = content.filter(
                        (block): block is SessionToolCallBlock =>
                            block.type === "tool_call" && block.server !== true,
                    );
                    if (calls.length === 0) continue;
                    await this.#runToolBatch(
                        calls.map((call, index) => ({
                            key: this.#toolKey(index, call.callId),
                            call,
                        })),
                        false,
                        abort.signal,
                        abortPromise,
                    );
                    responseOwed = true;
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
            await this.#appendFailure(
                error instanceof Error ? error.message : String(error),
            );
        }
        // The turn is over; a requested compaction runs now, before the next pass can start.
        await this.#runCompaction();
    }

    /**
     * Run the pending compaction, if any. The snapshot is taken here, with the turn over and
     * this pass being the only history writer, so nothing joins the history mid-compaction; the
     * suffix copy still keeps any such message, defensively. The replacement is appended as a
     * compaction record — the load-time reset point — and settles the shared promise for every
     * caller awaiting it. A provider failure rejects them and leaves the history untouched.
     */
    async #runCompaction(): Promise<void> {
        const pending = this.#compaction;
        if (pending === undefined) return;
        try {
            const session = await this.#ensureSession();
            const snapshot = [...this.#messages];
            const result = await session.compact(this.#ctx, {
                context: { instructions: this.#instructions(), messages: snapshot },
                ...(this.#model === undefined ? {} : { model: this.#model }),
            });
            if (result.status === "failed") {
                throw new Error(result.message);
            }
            if (result.status === "completed") {
                await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
                    const suffix = this.#messages.slice(snapshot.length);
                    const replaced = [...result.context.messages, ...suffix];
                    // Physically delete the superseded records and write the replacement —
                    // which keeps the messages that stay — in one atomic step.
                    await this.#persistence.transaction(lockCtx, async (txCtx) => {
                        await this.#persistence.clearRecords(txCtx);
                        await this.#persistence.append(txCtx, {
                            type: "compaction",
                            messages: replaced,
                        });
                    });
                    this.#messages = replaced;
                });
            }
            this.#compaction = undefined;
            pending.resolve();
        } catch (error: unknown) {
            this.#compaction = undefined;
            pending.reject(error);
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
                await this.#persistence.append(lockCtx, { type: "system", message: failure });
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
    async #consumeQueue(queue: QueueEntry[], mode: AgentBaseQueueMode): Promise<boolean> {
        return await this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
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
                if (this.#hooks.modelChanged !== undefined && model !== undefined) {
                    const changeCtx = withAgentBaseContext(this.#baseCtx, {
                        provider,
                        model,
                        effort,
                        serviceTier,
                    });
                    try {
                        injected = this.#hooks.modelChanged(changeCtx, {
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
                        // Hooks observe the run; they never fail it.
                    }
                    if (!reset) injected = undefined;
                }
            }
            await this.#persistence.transaction(lockCtx, async (txCtx) => {
                if (reset) {
                    await this.#persistence.clearRecords(txCtx);
                    if (injected !== undefined) {
                        await this.#persistence.append(txCtx, {
                            type: "system",
                            message: injected,
                        });
                    }
                }
                for (const entry of batch) {
                    await this.#persistence.append(txCtx, {
                        type: "user",
                        message: entry.message,
                    });
                    await this.#persistence.deleteValue(txCtx, entry.key);
                }
                if (changed) {
                    await this.#persistence.writeValue(txCtx, "settings", {
                        provider,
                        ...(model === undefined ? {} : { model }),
                        ...(effort === undefined ? {} : { effort }),
                        ...(serviceTier === undefined ? {} : { serviceTier }),
                    });
                }
            });
            queue.splice(0, count);
            if (reset) {
                this.#messages = injected === undefined ? [] : [injected];
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
            this.#messages.push(...batch.map((entry) => entry.message));
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
            let restored: SessionMessage[] = [];
            for (const record of records) {
                if (record.type === "compaction") {
                    // A compaction record carries the complete replacement context and
                    // supersedes everything before it.
                    restored = [...record.messages];
                    continue;
                }
                if (record.type === "user" || record.type === "tool" || record.type === "system") {
                    restored.push(record.message);
                    continue;
                }
                const last = restored[restored.length - 1];
                if (last?.role === "assistant") {
                    restored[restored.length - 1] = {
                        role: "assistant",
                        content: [...last.content, record.block],
                    };
                } else {
                    restored.push({ role: "assistant", content: [record.block] });
                }
            }
            const steering = await this.#persistence.readValues(lockCtx, "steering.");
            const sends = await this.#persistence.readValues(lockCtx, "send.");
            const pendingTools = await this.#persistence.readValues(lockCtx, "tool.");
            const settings = await this.#persistence.readValues(lockCtx, "settings");
            this.#messages = restored;
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
        entries: readonly { readonly key: string; readonly call: SessionToolCallBlock }[],
        resume: boolean,
        signal: AbortSignal,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<void> {
        if (!resume) {
            await this.#persistenceLock.runInLock(this.#ctx, (lockCtx) =>
                this.#persistence.transaction(lockCtx, async (txCtx) => {
                    for (const entry of entries) {
                        await this.#persistence.writeValue(txCtx, entry.key, entry.call);
                    }
                }),
            );
        }
        const results: (SessionToolResultMessage | undefined)[] = new Array(entries.length);
        let committed = 0;
        const commitReady = (): Promise<void> =>
            this.#persistenceLock.runInLock(this.#ctx, async (lockCtx) => {
                while (committed < entries.length) {
                    const entry = entries[committed];
                    const result = results[committed];
                    if (entry === undefined || result === undefined) return;
                    await this.#persistence.transaction(lockCtx, async (txCtx) => {
                        await this.#persistence.append(txCtx, {
                            type: "tool",
                            message: result,
                        });
                        await this.#persistence.deleteValue(txCtx, entry.key);
                    });
                    this.#messages.push(result);
                    committed += 1;
                }
            });
        await Promise.all(
            entries.map(async (entry, index) => {
                const outcome =
                    resume && !this.#isDurable(entry.call)
                        ? {
                              role: "tool" as const,
                              callId: entry.call.callId,
                              content: [
                                  {
                                      type: "text" as const,
                                      text: "The tool call was interrupted by a restart and was not retried.",
                                  },
                              ],
                              isError: true,
                          }
                        : await Promise.race([
                              this.#executeToolCall(
                                  withLifetime(this.#ctx, signal),
                                  entry.call,
                              ),
                              abortPromise,
                          ]);
                results[index] =
                    outcome === ABORTED
                        ? {
                              role: "tool",
                              callId: entry.call.callId,
                              content: [{ type: "text", text: "The tool call was aborted." }],
                              isError: true,
                          }
                        : outcome;
                await commitReady();
            }),
        );
    }

    #isDurable(call: SessionToolCallBlock): boolean {
        const tool = this.#tools().find(
            (candidate) =>
                candidate.name === call.name && candidate.namespace === call.namespace,
        );
        return tool?.durable === true;
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
        const tool = this.#tools().find(
            (candidate) =>
                candidate.name === call.name && candidate.namespace === call.namespace,
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
            const result: unknown = await tool.execute(ctx, args);
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

    /** Sorted after every earlier key of its queue, within this process and across restarts. */
    #queueKey(prefix: string): string {
        const time = String(Date.now()).padStart(14, "0");
        const sequence = String(this.#pendingSequence++).padStart(6, "0");
        return `${prefix}${time}.${sequence}`;
    }

    async #collect(
        stream: AsyncIterable<SessionEvent>,
        abortPromise: Promise<typeof ABORTED>,
    ): Promise<{
        readonly content: SessionAssistantBlock[];
        readonly state: SessionDoneState | undefined;
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
                this.#persistence.append(lockCtx, { type: "block", block }),
            );
            persisted.push(block);
        };
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
            const next = await Promise.race([iterator.next(), abortPromise]);
            if (next === ABORTED) {
                // Close the provider stream, drop the unfinished block, and end the turn.
                void Promise.resolve(iterator.return?.()).catch(() => undefined);
                this.#emit({ type: "done", state: "cancelled" });
                return { content: persisted, state: "cancelled" };
            }
            if (next.done === true) break;
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
                        ...(event.namespace === undefined ? {} : { namespace: event.namespace }),
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
                        content,
                        state: event.state,
                        ...(event.state === "error" ? { errorMessage: event.message } : {}),
                    };
                default:
                    break;
            }
        }
        return { content, state: undefined };
    }

    /**
     * Create the provider session on first use, resolving the provider from the registry by its
     * serializable ID at that moment; an unregistered ID fails the turn like any thrown error.
     */
    async #ensureSession(): Promise<BaseSession> {
        if (this.#session === undefined) {
            const provider = this.#providers.get(this.#providerId);
            if (provider === null) {
                throw new Error(`Provider "${this.#providerId}" is not registered.`);
            }
            this.#session = await provider.session(this.id, {
                instructions: this.#instructions(),
                tools: [...this.#tools()],
            });
        }
        return this.#session;
    }

    #emit(event: SessionEvent): void {
        try {
            this.#hooks.onEvent?.(this.#ctx, event);
        } catch {
            // Hooks observe the stream; they never fail a run.
        }
    }
}
