import type {
    BaseProvider,
    SessionDoneState,
    SessionEvent,
    SessionSystemMessage,
    SessionTokens,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AnyAgentTool } from "./AgentTool.js";

export type MaybePromise<Value> = Value | Promise<Value>;

/** What the `modelChanged` hook sees when a consumed message changes the effective model. */
export interface AgentBaseModelChange {
    readonly previousModel: string | undefined;
    readonly model: string;
    /** The registry ID of the provider serving the previous model. */
    readonly previousProvider: string;
    /** The registry ID of the provider serving the new model. */
    readonly provider: string;
    /** The registry the agent resolves its providers from. */
    readonly providers: AgentProviders;
    /** The live instance behind `previousProvider`, or null when no longer registered. */
    readonly previousProviderInstance: BaseProvider | null;
    /** The live instance behind `provider`, or null when not registered. */
    readonly providerInstance: BaseProvider | null;
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
 * Optional observation points. A hook must never fail or delay the run. Every hook receives the
 * agent's context, which carries the provider, model, and effort readable through
 * `agentBaseProvider`, `agentBaseModel`, and `agentBaseEffort`.
 */
export interface AgentBaseHooks {
    readonly onEvent?: (ctx: Context, event: SessionEvent) => void;
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
    /** Called when the loop leaves the settled state and begins working. */
    readonly beforeAgentLoop?: (ctx: Context) => MaybePromise<void>;
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
    /** Called immediately before each inference request. */
    readonly beforeInference?: (ctx: Context) => MaybePromise<void>;
    /**
     * Called immediately after each inference response is collected, with how it ended and the
     * token counts the provider measured for it.
     */
    readonly afterInference?: (ctx: Context, inference: AgentBaseInference) => MaybePromise<void>;
    /**
     * Called when a turn ends, with the conversation's measured size and whether the turn was
     * cancelled. Returned actions are all applied together before the loop continues; any of
     * them drives the loop into another turn.
     */
    readonly afterTurn?: (
        ctx: Context,
        turn: AgentBaseTurn,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /**
     * Called when the loop would settle back to idle. Returned actions are all applied together
     * and start the work over instead of settling.
     */
    readonly afterAgentLoop?: (
        ctx: Context,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /** Called once after the loop has fully settled and no feature reopened it. */
    readonly afterAgentSettled?: (ctx: Context) => MaybePromise<void>;
}
