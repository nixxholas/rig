import type { SessionEvent, SessionSystemMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type {
    AgentBaseInference,
    AgentBaseModelChange,
    AgentBaseToolExecution,
    AgentBaseTurn,
    AgentBaseTurnStart,
    MaybePromise,
} from "./AgentBaseHooks.js";
import type { AgentFeatureAction } from "./AgentFeatureAction.js";
import type { AnyAgentTool } from "./AgentTool.js";

/**
 * An individual feature class: one instance is built for each agent, so the instance may hold
 * that one agent's state and may be configured differently for each — a goal is the example, and
 * an agent whose configuration says nothing about it simply has no goal. The agent's ID is
 * offered to the constructor; a feature that does not need it simply takes no arguments.
 */
export interface AgentFeatureConstructor {
    new (agentId: string): AgentFeature;
}

/**
 * A shared feature class: one instance is built for the whole collection and serves every agent
 * in it — the system prompt, the model catalog, subagents, and autocompaction are all the same
 * capability wherever it runs. Its hooks therefore learn which agent they are running for from
 * the context, through `agentId`, `agentKV`, and `agentConfig`, and any per-agent state
 * it keeps in memory must be keyed by that ID rather than held as a single value.
 */
export interface SharedAgentFeatureConstructor {
    new (): AgentFeature;
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
    /** Observes every session event; must never fail or delay the run. */
    readonly onEvent?: (ctx: Context, event: SessionEvent) => void;
    /** Merged after the base state and every earlier feature's instructions, in feature order. */
    readonly instructions?: (ctx: Context) => MaybePromise<string>;
    /** Merged after the base state and every earlier feature's tools, in feature order. */
    readonly tools?: (ctx: Context) => MaybePromise<readonly Tool[]>;
    /**
     * Wraps validated tool execution. Features compose as nested middleware in array order.
     * See `AgentBaseHooks.aroundToolExecution` for the continuation contract.
     */
    readonly aroundToolExecution?: (
        ctx: Context,
        execution: AgentBaseToolExecution,
    ) => MaybePromise<unknown>;
    /** The first feature that returns a handoff message wins the reset injection. */
    readonly modelChanged?: (
        ctx: Context,
        change: AgentBaseModelChange,
    ) => MaybePromise<SessionSystemMessage | undefined>;
    /** Called when the loop leaves the settled state and begins working. */
    readonly beforeAgentLoop?: (ctx: Context) => MaybePromise<void>;
    /**
     * Receives the measured size of the context the turn is about to run on. Actions from every
     * feature are concatenated and applied before the turn's first inference.
     */
    readonly beforeTurn?: (
        ctx: Context,
        turn: AgentBaseTurnStart,
    ) => MaybePromise<readonly AgentFeatureAction[] | undefined>;
    /** Called immediately before each inference request. */
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
    /**
     * Called inside the transaction that records the agent as settled. The feature's own store
     * on this context writes into that transaction, so what a feature concludes about the run
     * and the fact that the run is over become durable together. The `Transact` suffix is what
     * marks a hook as running inside a transaction.
     *
     * Unlike the observing hooks, a failure here is not contained: it rolls the settlement back
     * along with everything every feature wrote, and the agent stays recorded as working.
     */
    readonly afterAgentSettledTransact?: (ctx: Context) => MaybePromise<void>;
    /** Called once after the loop has fully settled and no feature reopened it. */
    readonly afterAgentSettled?: (ctx: Context) => MaybePromise<void>;
}
