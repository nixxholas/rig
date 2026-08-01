import type { PermissionMode } from "../permissions/index.js";
import { mergeMcpTools } from "./mergeMcpTools.js";
import type { McpToolLoadOptions, McpToolLoadResult, McpToolProvider } from "./types.js";

/** Combines independent MCP sources before the session's one ordinary MCP merge step. */
export class CompositeMcpToolProvider implements McpToolProvider {
    readonly #providers: readonly McpToolProvider[];

    constructor(providers: readonly McpToolProvider[]) {
        this.#providers = [...providers];
    }

    async load(
        cwd: string,
        permissionMode: PermissionMode,
        options?: McpToolLoadOptions,
    ): Promise<McpToolLoadResult> {
        const loaded: McpToolLoadResult[] = [];
        try {
            for (const provider of this.#providers) {
                loaded.push(await provider.load(cwd, permissionMode, options));
            }
            let tools: McpToolLoadResult["tools"] = [];
            const servers: McpToolLoadResult["servers"][number][] = [];
            for (const contribution of loaded) {
                const merged = mergeMcpTools(tools, contribution);
                tools = merged.tools;
                servers.push(...merged.servers);
            }
            return {
                release: async () => {
                    await Promise.allSettled(
                        loaded.map((contribution) => contribution.release?.()),
                    );
                },
                servers,
                tools,
            };
        } catch (error) {
            await Promise.allSettled(loaded.map((contribution) => contribution.release?.()));
            throw error;
        }
    }

    async close(): Promise<void> {
        await Promise.allSettled(this.#providers.map((provider) => provider.close()));
    }
}
