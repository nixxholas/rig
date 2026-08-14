import { AgentKV, type AgentFeatureScope, type AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { ComputeFeature, type Compute } from "../../../sources/index.js";
import { InMemoryPersistence } from "../../support/InMemoryPersistence.js";

/** One agent's compute tools, with the feature they came from and a way to reach one by name. */
export interface ComputeToolset {
    readonly feature: ComputeFeature;
    readonly tools: readonly AnyAgentTool[];
    readonly tool: (name: string) => AnyAgentTool;
}

/**
 * The tools as an agent would receive them: one feature, one agent's own store, and the scope the
 * agent hands its features. Everything the tools remember goes through that store, so a test can
 * read a file with one tool and edit it with another exactly as a turn would.
 */
export function computeToolset(
    ctx: Context,
    compute: Compute,
    agentId = "compute-agent",
): ComputeToolset {
    const feature = new ComputeFeature({ compute });
    const kv = new AgentKV(new InMemoryPersistence(), `kv.${agentId}.`).scoped(
        "feature",
        "compute",
    );
    const scope = { agent: { id: agentId }, kv } as AgentFeatureScope;
    const tools = feature.tools(ctx, scope);
    return {
        feature,
        tools,
        tool: (name) => {
            const found = tools.find((candidate) => candidate.name === name);
            if (found === undefined) throw new Error(`The feature offers no tool called ${name}.`);
            return found;
        },
    };
}
