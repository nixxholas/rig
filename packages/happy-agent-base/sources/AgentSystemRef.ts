import type { SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentBaseMessageOptions } from "./AgentBase.js";
import type { AgentBaseKV } from "./AgentBaseKV.js";
import type { AgentConfig } from "./AgentConfig.js";
import type { AgentModel } from "./AgentModel.js";
import { AgentRef } from "./AgentRef.js";
import type { AgentSystem } from "./AgentSystem.js";

/**
 * A reference to a collection of agents that cannot deadlock, for code that runs inside an agent
 * — a feature hook, or a tool the run loop is waiting on. Every operation returns without
 * waiting for any agent's loop to reach a particular point.
 *
 * What is missing is missing on purpose. `delete` closes an agent and `start` resumes whole
 * agents; both are the owning caller's business, and both would wait for a loop that may be
 * waiting for the very code asking. The operations that remain keep only their asking form: the
 * `await: true` the agents themselves accept is not offered here and is never passed on, so no
 * call made through this type can wait for any agent's loop. Agents come back as `AgentRef` for
 * the same reason — handing out the real `Agent` would hand that flag back, along with `close`
 * and `waitForIdle`.
 */
export class AgentSystemRef {
    readonly #system: AgentSystem;

    constructor(system: AgentSystem) {
        this.#system = system;
    }

    /** The models this collection offers its agents. */
    get models(): readonly AgentModel[] {
        return this.#system.models;
    }

    /** Create an agent and get a reference to it. Creating an existing ID is an error. */
    async create(ctx: Context, agentId: string, config: AgentConfig): Promise<AgentRef> {
        return new AgentRef(await this.#system.create(ctx, agentId, config));
    }

    /** A reference to an existing agent; resolving one that was never created is an error. */
    async resolve(ctx: Context, agentId: string): Promise<AgentRef> {
        return new AgentRef(await this.#system.resolve(ctx, agentId));
    }

    /** Durable storage for one feature, shared by every agent in the collection. */
    featureState(feature: string): AgentBaseKV {
        return this.#system.featureState(feature);
    }

    /** The configuration an agent was created with, or undefined when there is no such agent. */
    async config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return await this.#system.config(ctx, agentId);
    }

    /** Queue a steered message, and resolve once the agent has taken it on. */
    async steer(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#system.steer(ctx, agentId, message, { ...options, await: false });
    }

    /** Queue a sent message, and resolve once the agent has taken it on. */
    async send(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#system.send(ctx, agentId, message, { ...options, await: false });
    }

    /** Ask an agent to compact, and resolve once it has been asked. */
    async compact(ctx: Context, agentId: string): Promise<void> {
        await (await this.resolve(ctx, agentId)).compact(ctx);
    }

    /** Cancel an agent's active turn, and resolve once the cancellation has been signalled. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        await (await this.resolve(ctx, agentId)).abort(ctx);
    }
}
