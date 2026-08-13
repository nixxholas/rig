import type { SessionEvent, SessionSystemMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type {
    AgentBaseInference,
    AgentBaseModelChange,
    AgentBaseTurn,
    AgentBaseTurnStart,
    MaybePromise,
} from "./AgentBaseHooks.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

/**
 * A feature class that can be instantiated for one agent. The agent's ID is offered to the
 * constructor; a feature that does not need it simply takes no arguments.
 */
export interface AgentFeatureConstructor {
    new (agentId: string): AgentFeature;
}

/**
 * One independent capability of an `Agent`: a feature implements any subset of the agent hooks,
 * and the agent merges every feature's implementations into the singular hooks its internal
 * `AgentBase` runs with. The hook contracts are the same as `AgentBaseHooks`; see there for
 * when each hook fires and what its return value means.
 */
export interface AgentFeature<Tool extends AnyAgentTool = AnyAgentTool> {
    /**
     * A stable identifier for the feature. Its persisted key-value entries live under this
     * name, so renaming a feature orphans everything it stored.
     */
    readonly name: string;
    /**
     * Load this feature's dependencies before its owning agent becomes available. Omit it when
     * the feature has nothing to load.
     */
    readonly load?: (ctx: Context) => Promise<void>;
    readonly onEvent?: (ctx: Context, event: SessionEvent) => void;
    /** Merged after the base state and every earlier feature's instructions, in feature order. */
    readonly instructions?: (ctx: Context) => MaybePromise<string>;
    /** Merged after the base state and every earlier feature's tools, in feature order. */
    readonly tools?: (ctx: Context) => MaybePromise<readonly Tool[]>;
    /** The first feature that returns a handoff message wins the reset injection. */
    readonly modelChanged?: (
        ctx: Context,
        change: AgentBaseModelChange,
    ) => MaybePromise<SessionSystemMessage | undefined>;
    readonly beforeAgentLoop?: (ctx: Context) => MaybePromise<void>;
    /**
     * Receives the measured size of the context the turn is about to run on. Actions from every
     * feature are concatenated and applied before the turn's first inference.
     */
    readonly beforeTurn?: (
        ctx: Context,
        turn: AgentBaseTurnStart,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    readonly beforeInference?: (ctx: Context) => MaybePromise<void>;
    /** Receives how the response ended and the token counts the provider measured for it. */
    readonly afterInference?: (ctx: Context, inference: AgentBaseInference) => MaybePromise<void>;
    /**
     * Receives the token counts the turn's last measured response reported. Actions from every
     * feature are concatenated and applied together.
     */
    readonly afterTurn?: (
        ctx: Context,
        turn: AgentBaseTurn,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /** Actions from every feature are concatenated and applied together. */
    readonly afterAgentLoop?: (
        ctx: Context,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /** Called once after the loop has fully settled and no feature reopened it. */
    readonly afterAgentSettled?: (ctx: Context) => MaybePromise<void>;
}
