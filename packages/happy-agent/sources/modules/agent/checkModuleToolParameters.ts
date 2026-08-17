import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

type LoadedModule = AgentModule<AnyAgentTool, LibSQLDatabase>;
type LoadedHooks = AgentModuleHooks<AnyAgentTool, LibSQLDatabase>;

/**
 * Rejects a tool whose parameters are not an object at the top level, as the module assembles it.
 *
 * Every provider requires an object root and refuses the entire request otherwise, so one such tool
 * kills every turn before inference, with nothing in the transcript to say why. Failing here instead
 * names the tool at the moment its module offers it.
 *
 * A module's hooks are private to it and only ever surface as the object its `beforeStart` returns,
 * so that entry point is what gets replaced: the original still runs and still builds the module's
 * own state, and only the `tools` hook in what it returned is wrapped. The module's identity and
 * every other hook are left exactly as they were.
 */
export function checkModuleToolParameters(module: LoadedModule): LoadedModule {
    const beforeStart = module.beforeStart;
    if (beforeStart === undefined) return module;
    Object.defineProperty(module, "beforeStart", {
        configurable: true,
        value: async (
            ctx: Context,
            agents: AgentSystemRef<LibSQLDatabase>,
        ): Promise<LoadedHooks | void> => {
            const hooks = await beforeStart.call(module, ctx, agents);
            const tools = hooks?.tools;
            if (hooks === undefined || tools === undefined) return hooks;
            return {
                ...hooks,
                tools: async (toolCtx: Context, scope: AgentModuleScope<LibSQLDatabase>) =>
                    assertObjectRootedParameters(await tools(toolCtx, scope)),
            };
        },
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
