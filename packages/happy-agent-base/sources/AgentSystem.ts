import type { SessionMessage, SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { Agent } from "./Agent.js";
import type { AgentBaseAwaitOptions, AgentBaseMessageOptions } from "./AgentBase.js";
import type { AgentBaseKV } from "./AgentBaseKV.js";
import type { AgentConfig } from "./AgentConfig.js";
import type { AgentModel } from "./AgentModel.js";
import type { AgentFeature } from "./AgentFeature.js";

/** Conversation state installed atomically before a newly created agent starts. */
export interface AgentInitialContext {
    /** The conversation installed as the agent's history before its first turn runs. */
    readonly messages: readonly SessionMessage[];
}

/**
 * A collection of agents addressed by ID: what an owner can ask of the agents it runs. An agent
 * exists only once it has been created with its configuration, which is persisted and stays in
 * effect for the agent's whole life; resolving one that was never created is an error.
 *
 * This is the full surface, including the operations that wait for an agent's run loop to reach a
 * particular point — `delete`, and anything reached through the returned `Agent`. Those are for
 * the caller that owns the agents' lifetime. Code running *inside* an agent, such as a feature
 * hook or a tool, is waited for by that loop and must not wait for it in turn: it should hold an
 * `AgentSystemRef`, whose every operation returns without waiting for a loop.
 */
export interface AgentSystem {
    /** The models this collection offers its agents. */
    readonly models: readonly AgentModel[];

    /**
     * Create an agent with a new system-generated cuid2 identity and the configuration it keeps
     * for its whole life. The configuration and optional initial context are persisted before
     * the agent runs; a creation that fails to produce an agent leaves no identity behind.
     */
    create(ctx: Context, config: AgentConfig, initialContext?: AgentInitialContext): Promise<Agent>;

    /** Close an agent and release its identity, so the same ID can be created again. */
    delete(ctx: Context, agentId: string): Promise<void>;

    /** The configuration an agent was created with, or undefined when there is no such agent. */
    config(ctx: Context, agentId: string): Promise<AgentConfig | undefined>;

    /** The live agent for an ID, loading it if this process has not seen it yet. */
    resolve(ctx: Context, agentId: string): Promise<Agent>;

    /** Resolve and resume every agent that has work left from before this process started. */
    start(ctx: Context): Promise<void>;

    /**
     * Durable storage for one feature, shared by every agent in the collection and outliving all
     * of them. An agent's own store belongs to its conversation and is erased along with its
     * identity; this is where a feature keeps what is true of the collection rather than of one
     * conversation — above all work one agent owes another, which a process disappearing
     * mid-handover must not take with it.
     */
    featureState(feature: string): AgentBaseKV;

    /** A collection-wide feature by its stable name. */
    feature(name: string): AgentFeature | undefined;

    /**
     * Queue a user message for an agent, injected as soon as its current response and tool batch
     * finish.
     */
    steer(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void>;

    /** Queue a user message for an agent that injects only when the agent would otherwise stop. */
    send(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions & AgentBaseAwaitOptions,
    ): Promise<void>;

    /** Cancel an agent's active turn, leaving its queued messages durable for the next one. */
    abort(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void>;

    /** Ask an agent for its conversation to be replaced by the provider's summary of it. */
    compact(ctx: Context, agentId: string, options?: AgentBaseAwaitOptions): Promise<void>;
}
