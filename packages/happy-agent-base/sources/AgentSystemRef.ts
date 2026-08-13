import type { SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { AgentBaseMessageOptions } from "./AgentBase.js";
import type { AgentConfig } from "./AgentConfig.js";
import type { AgentModel } from "./AgentModel.js";
import { acceptanceIsWaitable, AgentRef } from "./AgentRef.js";
import type { AgentInitialContext, AgentSystem } from "./AgentSystem.js";

/**
 * A reference to a collection of agents that cannot deadlock, for code that runs inside an agent
 * — a feature hook, or a tool the run loop is waiting on. Every operation returns without
 * waiting for any agent's loop to reach a particular point.
 *
 * What is missing is missing on purpose. `delete` closes an agent and `start` resumes whole
 * agents; both are the owning caller's business, and both would wait for a loop that may be
 * waiting for the very code asking. Agents come back as `AgentRef` for the same reason — handing
 * out the real `Agent` would hand back `close` and `waitForIdle` along with the `await: true`
 * that waits for a compaction or an unwound turn.
 *
 * A message is the one thing a caller here may be told about, because accepting one is a durable
 * queue write rather than a turn: `steer` and `send` resolve once the message is safely part of
 * the target agent's conversation, and reject when that write fails, so a caller routing work to
 * another agent knows whether it arrived. The exception is the caller's own agent, whose loop is
 * what would have to perform that write — asked for itself, the message is queued and not waited
 * for. That is decided from the context, which names the agent the caller is running inside; a
 * context that names none proves nothing, so nothing is waited for there either.
 */
export class AgentSystemRef {
    /** The collection this reference forwards every operation to without waiting on its loops. */
    readonly #system: AgentSystem;

    /** Wrap a collection as the deadlock-free reference given to code running inside it. */
    constructor(system: AgentSystem) {
        this.#system = system;
    }

    /** The models this collection offers its agents. */
    get models(): readonly AgentModel[] {
        return this.#system.models;
    }

    /** Create an agent with a new system-generated cuid2 identity. */
    async create(
        ctx: Context,
        config: AgentConfig,
        initialContext?: AgentInitialContext,
    ): Promise<AgentRef> {
        return new AgentRef(await this.#system.create(ctx, config, initialContext));
    }

    /** A reference to an existing agent; resolving one that was never created is an error. */
    async resolve(ctx: Context, agentId: string): Promise<AgentRef> {
        return new AgentRef(await this.#system.resolve(ctx, agentId));
    }

    /** The configuration an agent was created with, or undefined when there is no such agent. */
    async config(ctx: Context, agentId: string): Promise<AgentConfig | undefined> {
        return await this.#system.config(ctx, agentId);
    }

    /**
     * Queue a steered message. For another agent this resolves once the message is durably
     * accepted and rejects when that write fails; for the caller's own agent it resolves as soon
     * as the agent has taken the request on.
     */
    async steer(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#system.steer(ctx, agentId, message, {
            ...options,
            await: acceptanceIsWaitable(ctx, agentId),
        });
    }

    /**
     * Queue a sent message. For another agent this resolves once the message is durably accepted
     * and rejects when that write fails; for the caller's own agent it resolves as soon as the
     * agent has taken the request on.
     */
    async send(
        ctx: Context,
        agentId: string,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#system.send(ctx, agentId, message, {
            ...options,
            await: acceptanceIsWaitable(ctx, agentId),
        });
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
