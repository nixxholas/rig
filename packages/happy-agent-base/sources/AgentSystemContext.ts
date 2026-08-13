import { createContextNamespace, type Context } from "@steve.kite/stdlib";

import type { AgentSystem } from "./AgentSystem.js";

const agentSystemNamespace = createContextNamespace<AgentSystem | undefined>(
    "happyAgentBase.agentSystem",
    undefined,
);

/** Carry the collection that owns an agent and its features. */
export function withAgentSystem(ctx: Context, value: AgentSystem): Context {
    return agentSystemNamespace.set(ctx, value);
}

/** The collection owning the current feature or agent operation. */
export function agentSystem(ctx: Context): AgentSystem | undefined {
    return agentSystemNamespace.get(ctx);
}
