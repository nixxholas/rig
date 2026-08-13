import type {
    SessionDoneState,
    SessionEvent,
    SessionReasoningBlock,
    SessionSystemMessage,
    SessionTextBlock,
    SessionTokens,
    SessionToolCallBlock,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AnyAgentTool } from "./AgentTool.js";

/** A value or a promise of it; every hook may answer either synchronously or asynchronously. */
export type MaybePromise<Value> = Value | Promise<Value>;

/**
 * A provider event whose completed assistant block is being committed to durable history.
 *
 * Raw stream observation still belongs to `onEvent`. This narrower event is delivered only for
 * valid terminal block events, inside the transaction that appends `block`, so starts, deltas,
 * retries, usage, done events, unmatched ends, and abandoned partial blocks never appear here.
 */
export type AgentBasePersistedEvent =
    | (Extract<SessionEvent, { readonly type: "text_end" }> & {
          readonly block: SessionTextBlock;
      })
    | (Extract<SessionEvent, { readonly type: "reasoning_end" }> & {
          readonly block: SessionReasoningBlock;
      })
    | (Extract<SessionEvent, { readonly type: "toolcall_end" }> & {
          readonly block: SessionToolCallBlock;
      });

/** What the `modelChanged` hook sees when a consumed message changes the effective model. */
export interface AgentBaseModelChange {
    /** The model in force before this change, absent when none had been set yet. */
    readonly previousModel: string | undefined;
    /** The model now in force. */
    readonly model: string;
    /** The registry ID of the provider serving the previous model. */
    readonly previousProvider: string;
    /** The registry ID of the provider serving the new model. */
    readonly provider: string;
    /** The registry the agent resolves its providers from. */
    readonly providers: AgentProviders;
    /** True when the change was incompatible and the conversation history was erased. */
    readonly wasReset: boolean;
}

/** What the `afterInference` hook sees about the response that just completed. */
export interface AgentBaseInference {
    /** How the response ended, or undefined when the stream ended without a done event. */
    readonly state: SessionDoneState | undefined;
    /**
     * The real token counts the provider reported for this response: the complete input context
     * it received plus the output it generated. Absent when the response was cancelled, failed,
     * or ended without a done event, since no count was measured.
     */
    readonly tokens: SessionTokens | undefined;
    /** The failure text of a provider-reported error response. */
    readonly errorMessage?: string;
}

/** What `beforeTurn` sees about the conversation the turn is about to run on. */
export interface AgentBaseTurnStart {
    /**
     * The true size of the conversation context in tokens, as the provider last measured it:
     * the complete input it received plus the output it generated. It is durable, so it
     * survives a restart, and it is cleared whenever the conversation is replaced — by a
     * compaction or by a reset — until the next response measures the new one. Absent only
     * before any response has been measured.
     */
    readonly contextTokens: number | undefined;
}

/** What `afterTurn` sees about the turn that just ended. */
export interface AgentBaseTurn extends AgentBaseTurnStart {
    /**
     * True when the turn was cancelled by `abort`. The work it had already done stays in the
     * history, but it stopped early, so a feature should generally not act on it.
     */
    readonly aborted: boolean;
}

/**
 * One validated tool invocation offered to an around-execution correctness hook.
 *
 * A wrapper calls `execute` to continue to the next wrapper and, ultimately, the tool. Repeated
 * calls join the same execution rather than repeating side effects.
 */
export interface AgentBaseToolExecution {
    /** The ID the model attached to this call, used to match its eventual result back to it. */
    readonly callId: string;
    /** The tool definition the call resolved to. */
    readonly tool: AnyAgentTool;
    /** The call's arguments, already parsed from JSON but not yet validated against the schema. */
    readonly arguments: unknown;
    /** Continue to the next wrapper and, ultimately, the tool itself. */
    readonly execute: () => Promise<unknown>;
}

/**
 * Optional observation points. A hook must never fail or delay the run. Every hook receives the
 * agent's context, which carries the provider, model, and effort readable through
 * `agentProvider`, `agentModel`, and `agentEffort`.
 */
export interface AgentBaseHooks {
    /** Called for every session event the provider emits, for observation only. */
    readonly onEvent?: (ctx: Context, event: SessionEvent) => void;
    /**
     * Called only for a completed assistant block, inside the transaction that appends it to
     * durable history. A failure rolls the append and every write made by this hook back.
     */
    readonly onEventTransact?: (ctx: Context, event: AgentBasePersistedEvent) => MaybePromise<void>;
    /**
     * Extends `state.instructions` for the session, consulted before each inference and
     * compaction. This is a correctness hook: a failure fails the turn loudly instead of
     * silently running with a wrong prompt.
     */
    readonly instructions?: (ctx: Context) => MaybePromise<string>;
    /**
     * Extends `state.tools` for the session, consulted before each inference and tool
     * execution. This is a correctness hook: a failure — including duplicate tool names in
     * the merged list — fails the turn loudly instead of silently running with wrong tools.
     * When the merged descriptors change between inferences, the provider session is
     * recreated so the model sees the current tools.
     */
    readonly tools?: (ctx: Context) => MaybePromise<readonly AnyAgentTool[]>;
    /**
     * Wraps execution after the tool exists and its JSON arguments pass runtime validation.
     * This is a correctness hook: a failure becomes that call's error result. The hook must call
     * `execution.execute()` to continue; omitting it deliberately replaces the execution, while
     * repeated calls join the same downstream work.
     */
    readonly aroundToolExecution?: (
        ctx: Context,
        execution: AgentBaseToolExecution,
    ) => MaybePromise<unknown>;
    /**
     * Called when a consumed message changes the effective model. An incompatible change —
     * judged by the provider-model compatibility matrix — erases the conversation history
     * completely and destroys the old provider session; the handoff system message this hook
     * returns is then injected at the very beginning of the fresh context, and without one the
     * context starts completely empty. On a compatible change the history stays and the return
     * value is ignored. A hook failure during an incompatible change rejects the switch: the
     * previous selection stays effective and the history is not cleared.
     */
    readonly modelChanged?: (
        ctx: Context,
        change: AgentBaseModelChange,
    ) => MaybePromise<SessionSystemMessage | undefined>;
    /**
     * Runs after the agent is staged as working, inside the transaction committing that state.
     */
    readonly beforeAgentLoopTransact?: (ctx: Context) => MaybePromise<void>;
    /** Called when the loop leaves the settled state and begins working. */
    readonly beforeAgentLoop?: (ctx: Context) => MaybePromise<void>;
    /** Runs inside the transaction committing the inference stage for the turn being opened. */
    readonly beforeTurnTransact?: (ctx: Context, turn: AgentBaseTurnStart) => MaybePromise<void>;
    /**
     * Called at the start of each turn, before its queues drain, with the conversation's
     * measured size. Returned actions are applied before the turn runs, so a `compact` action
     * here compacts the conversation the turn is about to send — never a context left
     * mid-tool-call by the previous turn.
     */
    readonly beforeTurn?: (
        ctx: Context,
        turn: AgentBaseTurnStart,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /** Runs inside the transaction committing the inference stage for the request being made. */
    readonly beforeInferenceTransact?: (ctx: Context) => MaybePromise<void>;
    /** Called immediately before each inference request. */
    readonly beforeInference?: (ctx: Context) => MaybePromise<void>;
    /**
     * Runs inside the transaction committing the response's measured context size. A response
     * without a measurement instead recommits its inference stage with this hook.
     */
    readonly afterInferenceTransact?: (
        ctx: Context,
        inference: AgentBaseInference,
    ) => MaybePromise<void>;
    /**
     * Called immediately after each inference response is collected, with how it ended and the
     * token counts the provider measured for it.
     */
    readonly afterInference?: (ctx: Context, inference: AgentBaseInference) => MaybePromise<void>;
    /** Runs inside the transaction committing the stage left by the completed turn. */
    readonly afterTurnTransact?: (ctx: Context, turn: AgentBaseTurn) => MaybePromise<void>;
    /**
     * Called when a turn ends, with the conversation's measured size and whether the turn was
     * cancelled. Returned actions are all applied together before the loop continues; any of
     * them drives the loop into another turn.
     */
    readonly afterTurn?: (
        ctx: Context,
        turn: AgentBaseTurn,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /** Runs inside the transaction committing the stage left by the completed loop. */
    readonly afterAgentLoopTransact?: (ctx: Context) => MaybePromise<void>;
    /**
     * Called when the loop would settle back to idle. Returned actions are all applied together
     * and start the work over instead of settling.
     */
    readonly afterAgentLoop?: (
        ctx: Context,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /**
     * Called inside the transaction that settles the agent, before the settlement commits. The
     * key-value store on the context writes into that same transaction, so a conclusion about
     * the run and the fact that the run is over become durable together, without a second commit
     * a crash could land between. The `Transact` suffix is what marks this: a hook carrying it
     * runs inside a transaction, and everything it writes commits or rolls back with it.
     *
     * Unlike the observing hooks, a failure here is not swallowed. It rolls the settlement back,
     * leaving the agent recorded as still working, because a conclusion that failed to be
     * written must not be reported as one that was. The store handle is lent for the call only.
     */
    readonly afterAgentSettledTransact?: (ctx: Context) => MaybePromise<void>;
    /** Called once after the loop has fully settled and no feature reopened it. */
    readonly afterAgentSettled?: (ctx: Context) => MaybePromise<void>;
}
