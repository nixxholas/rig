import type {
    BaseProvider,
    SessionEvent,
    SessionSystemMessage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AgentProviders } from "./AgentProviders.js";
import type { AnyAgentTool } from "./AgentTool.js";

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

/**
 * Optional observation points. A hook must never fail or delay the run. Every hook receives the
 * agent's context, which carries the provider, model, and effort readable through
 * `agentBaseProvider`, `agentBaseModel`, and `agentBaseEffort`.
 */
export interface AgentBaseHooks {
    readonly onEvent?: (ctx: Context, event: SessionEvent) => void;
    /**
     * The system prompt for the session, consulted before each inference and compaction.
     * When absent — or when it throws — the agent falls back to `state.instructions`.
     */
    readonly instructions?: (ctx: Context) => string;
    /**
     * The tools for the session, consulted before each inference and tool execution. When
     * absent — or when it throws — the agent falls back to `state.tools`.
     */
    readonly tools?: (ctx: Context) => readonly AnyAgentTool[];
    /**
     * Called when a consumed message changes the effective model. An incompatible change —
     * judged by the provider-model compatibility matrix — erases the conversation history
     * completely and destroys the old provider session; the handoff system message this hook
     * returns is then injected at the very beginning of the fresh context, and without one the
     * context starts completely empty. On a compatible change the history stays and the return
     * value is ignored.
     */
    readonly modelChanged?: (
        ctx: Context,
        change: AgentBaseModelChange,
    ) => SessionSystemMessage | undefined;
    /** Called when the loop leaves the settled state and begins working. */
    readonly beforeAgentLoop?: (ctx: Context) => void;
    /** Called at the start of each turn, before its queues drain. */
    readonly beforeTurn?: (ctx: Context) => void;
    /** Called immediately before each inference request. */
    readonly beforeInference?: (ctx: Context) => void;
    /** Called immediately after each inference response is collected. */
    readonly afterInference?: (ctx: Context) => void;
    /**
     * Called when a turn ends. Returned actions are all applied together before the loop
     * continues; any of them drives the loop into another turn.
     */
    readonly afterTurn?: (ctx: Context) => readonly AgentFeatureAction[] | undefined;
    /**
     * Called when the loop would settle back to idle. Returned actions are all applied together
     * and start the work over instead of settling.
     */
    readonly afterAgentLoop?: (ctx: Context) => readonly AgentFeatureAction[] | undefined;
}
