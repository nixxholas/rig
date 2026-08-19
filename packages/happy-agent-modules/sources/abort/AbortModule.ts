import type { AgentModule, AgentModuleHooks, AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/** The largest descendant tree one abort operation will hold in memory. */
export const MAX_ABORT_CHAIN_AGENTS = 10_000;

/**
 * Cancels one agent and every agent below it as one transactionally released operation.
 *
 * The module reads one stable ancestry snapshot and registers every abort on the same transaction.
 * A traversal or resolution failure therefore releases no aborts, while commit immediately
 * signals the whole chain from its leaves to its root. It never waits for any run, provider,
 * tool, or descendant to settle.
 */
export class AbortModule implements AgentModule {
    readonly name = "abort";

    #agents: AgentSystemRef | undefined;

    /** Immediately abort the target and every descendant without waiting for them to settle. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        const agents = this.#requireAgents();
        await ctx.inTx(async (txCtx) => {
            const chain = await descendantChain(txCtx, agents, agentId);
            // A descendant can report its settlement to its parent. Release leaf cancellations
            // first so those reports arrive before the ancestor's cancellation and cannot reopen
            // an ancestor that was already signalled.
            for (const targetAgentId of [...chain].reverse()) {
                await agents.abort(txCtx, targetAgentId);
            }
        });
    }

    /** Capture the collection whose ancestry and abort operation this module composes. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {};
    };

    #requireAgents(): AgentSystemRef {
        const agents = this.#agents;
        if (agents === undefined) throw new Error("The abort module has not been started yet.");
        return agents;
    }
}

/** Read one bounded breadth-first snapshot and reject anything that is not a tree. */
async function descendantChain(
    ctx: Context,
    agents: AgentSystemRef,
    rootAgentId: string,
): Promise<readonly string[]> {
    const pending = [rootAgentId];
    const visited = new Set<string>();
    for (let index = 0; index < pending.length; index += 1) {
        const agentId = pending[index];
        if (agentId === undefined) continue;
        if (visited.has(agentId)) {
            throw new Error("The agent descendant chain contains a cycle or duplicate identity.");
        }
        if (visited.size >= MAX_ABORT_CHAIN_AGENTS) {
            throw new Error(
                `An abort is limited to ${String(MAX_ABORT_CHAIN_AGENTS)} agents in one chain.`,
            );
        }
        visited.add(agentId);
        pending.push(...(await agents.childOf(ctx, agentId)));
    }
    return [...visited];
}
