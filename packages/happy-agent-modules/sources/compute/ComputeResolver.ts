import type { Context } from "@steve.kite/stdlib";

import type { HostCompute } from "./ComputeModule.js";

/** Shared boundary used by filesystem-grounded modules to obtain an agent's cached compute. */
export interface ComputeResolver {
    resolve(ctx: Context, agentId: string): Promise<HostCompute | undefined>;
}