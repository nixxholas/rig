import {
    AgentKV,
    type AgentModuleScope,
    type AgentToolCall,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { GeminiModule, type HostCompute } from "../../../sources/index.js";
import { InMemoryPersistence } from "../../support/InMemoryPersistence.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";

/** One agent's Gemini tools, with a way to reach one by name and the call they run under. */
export interface GeminiToolset {
    readonly module: GeminiModule;
    readonly tools: readonly AnyAgentTool[];
    readonly tool: (name: string) => Omit<AnyAgentTool, "execute"> & {
        readonly execute: (ctx: Context, input: any, call?: AgentToolCall) => Promise<any>;
    };
    readonly call: AgentToolCall;
}

/**
 * The tools as an agent would receive them: one module over one machine, one agent's own store,
 * and a `fetch` that answers instead of a network.
 */
export async function geminiToolset(
    ctx: Context,
    compute: HostCompute,
    options: {
        readonly agentId?: string;
        readonly apiKey?: string;
        readonly fetch?: typeof fetch;
    } = {},
): Promise<GeminiToolset> {
    const agentId = options.agentId ?? "gemini-agent";
    const module = new GeminiModule({
        apiKey: options.apiKey ?? "secret-key",
        compute: { resolve: async () => compute },
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const kv = new AgentKV(new InMemoryPersistence(), `kv.${agentId}.`).scoped("module", "gemini");
    const scope = { agent: { id: agentId }, kv } as AgentModuleScope;
    const hooks = await resolveModuleHooks(ctx, module);
    const tools = await hooks.tools!(ctx, scope);
    const call: AgentToolCall = {
        id: "gemini-test-call",
        providerCallId: "gemini-test-provider-call",
        kv: kv.scoped("call", "gemini-test-call"),
        commit: async (_commitCtx, result) => result,
    };
    return {
        module,
        tools,
        call,
        tool: (name) => {
            const found = tools.find((candidate) => candidate.name === name);
            if (found === undefined) throw new Error(`The module offers no tool called ${name}.`);
            return {
                ...found,
                execute: async (executeCtx: Context, input: any, providedCall?: AgentToolCall) =>
                    await found.execute(executeCtx, input, providedCall ?? call),
            };
        },
    };
}
