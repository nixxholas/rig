import type { SessionUserMessage } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type { Agent } from "./Agent.js";
import type { AgentBaseMessageOptions } from "./AgentBase.js";
import { agentId } from "./AgentContexts.js";
import type { AgentMetadata } from "./AgentMetadata.js";

/**
 * Whether this caller may be told that `agentId` durably accepted a message. Acceptance is a
 * queue write under that agent's own persistence lock, so waiting for it is safe from anywhere
 * except inside that agent's loop, which is holding the lock the write needs. The proof is the
 * caller's context naming a different agent; a context naming none proves nothing.
 */
export function acceptanceIsWaitable(ctx: Context, target: string): boolean {
    const caller = agentId(ctx);
    return caller !== undefined && caller !== target;
}

/**
 * A reference to an agent for code that runs inside one — a feature hook, or a tool the run loop
 * is waiting on. No operation here waits for a run loop: `compact` and `abort` are requests that
 * resolve once they have been made, and there is no `close`, `waitForIdle` or `start`, each of
 * which is whole-agent lifetime owned by whoever created the agent and nothing *but* the wait
 * this caller must not make.
 *
 * Messages are different, because accepting one is a durable queue write rather than a turn.
 * Addressed to another agent, `steer` and `send` resolve once the message really is part of that
 * agent's conversation and reject when the write fails, so a caller routing work elsewhere knows
 * whether it arrived. Addressed to the agent the caller is running inside — whose loop would have
 * to perform that write — the message is queued and not waited for. The context decides, since it
 * names the agent the caller is in; a context that names none proves nothing and waits for
 * nothing.
 */
export class AgentRef {
    /** The agent this reference wraps. */
    readonly #agent: Agent;
    /** The durable parent captured when this reference was resolved, or `null` for a root. */
    readonly parent: string | null;

    constructor(agent: Agent, parent: string | null = null) {
        this.#agent = agent;
        this.parent = parent;
    }

    /** The wrapped agent's ID. */
    get id(): string {
        return this.#agent.id;
    }

    /** Queue a message that injects as soon as the current response and its tool batch finish. */
    async steer(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#agent.steer(ctx, message, {
            ...options,
            await: acceptanceIsWaitable(ctx, this.#agent.id),
        });
    }

    /** Queue a message that injects when the agent would otherwise stop. */
    async send(
        ctx: Context,
        message: SessionUserMessage,
        options?: AgentBaseMessageOptions,
    ): Promise<void> {
        await this.#agent.send(ctx, message, {
            ...options,
            await: acceptanceIsWaitable(ctx, this.#agent.id),
        });
    }

    /** Shallow-merge fields into this agent's immutable metadata. */
    async updateMetadata(ctx: Context, update: AgentMetadata): Promise<void> {
        await this.#agent.updateMetadata(ctx, update);
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
