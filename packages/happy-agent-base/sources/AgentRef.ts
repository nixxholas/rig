import type { SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { Agent } from "./Agent.js";
import type { AgentBaseMessageOptions } from "./AgentBase.js";

/**
 * A reference to an agent for code that runs inside one — a feature hook, or a tool the run loop
 * is waiting on. Every operation asks the agent for something and returns as soon as the request
 * has been taken on. Nothing here can be waited for: the agent's own operations take an
 * `await: true` that this type does not accept, and does not pass on.
 *
 * That is deliberately blunter than the agent's own rule. The agent refuses a wait only when the
 * caller's context says it is inside that same agent's loop, which is exact but depends on the
 * context being the right one; a reference held across a boundary, stored on a feature, or used
 * from a callback that outlived its hook has no such guarantee. Since a caller in this position
 * has no business waiting for any agent's loop anyway, the option simply is not offered.
 *
 * For the same reason there is no `close`, `waitForIdle` or `start`: whole-agent lifetime, owned
 * by whoever created the agent, and each nothing *but* the wait this caller must not make.
 */
export class AgentRef {
    readonly #agent: Agent;

    constructor(agent: Agent) {
        this.#agent = agent;
    }

    get id(): string {
        return this.#agent.id;
    }

    /** Queue a message that injects as soon as the current response and its tool batch finish. */
    async steer(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#agent.steer(ctx, message, { ...options, await: false });
    }

    /** Queue a message that injects when the agent would otherwise stop. */
    async send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#agent.send(ctx, message, { ...options, await: false });
    }

    /** Ask the agent to compact, which it does between turns. */
    async compact(ctx: Context): Promise<void> {
        await this.#agent.compact(ctx, { await: false });
    }

    /** Cancel the agent's active turn. */
    async abort(ctx: Context): Promise<void> {
        await this.#agent.abort(ctx, { await: false });
    }
}
