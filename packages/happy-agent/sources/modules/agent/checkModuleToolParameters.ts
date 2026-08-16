import type { AgentModule, AgentModuleScope, AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

type LoadedModule = AgentModule<AnyAgentTool, LibSQLDatabase>;

/**
 * Rejects a tool whose parameters are not an object at the top level, as the module assembles it.
 *
 * Every provider requires an object root and refuses the entire request otherwise, so one such tool
 * kills every turn before inference, with nothing in the transcript to say why. Failing here instead
 * names the tool at the moment its module offers it.
 *
 * The module's own `tools` hook is replaced rather than wrapped in a proxy, because a module is a
 * class instance with private state and the hook is an ordinary own property: swapping it leaves the
 * module's identity and every other hook exactly as they were.
 */
export function checkModuleToolParameters(module: LoadedModule): LoadedModule {
    const tools = module.tools;
    if (tools === undefined) return module;
    Object.defineProperty(module, "tools", {
        configurable: true,
        value: async (ctx: Context, scope: AgentModuleScope) =>
            assertObjectRootedParameters(await tools(ctx, scope)),
        writable: true,
    });
    return module;
}

function assertObjectRootedParameters(tools: readonly AnyAgentTool[]): readonly AnyAgentTool[] {
    const rejected = tools
        .filter((tool) => !isObjectRooted(tool.parameters))
        .map((tool) => tool.name);
    if (rejected.length > 0) {
        throw new Error(
            `These tools declare parameters that are not an object at the top level, which every model provider refuses: ${rejected.join(", ")}.`,
        );
    }
    return tools;
}

/** A union, array, or bare value at the root is what providers reject; everything else passes. */
export function isObjectRooted(parameters: unknown): boolean {
    if (parameters === undefined) return true;
    return (
        typeof parameters === "object" &&
        parameters !== null &&
        (parameters as { readonly type?: unknown }).type === "object"
    );
}
