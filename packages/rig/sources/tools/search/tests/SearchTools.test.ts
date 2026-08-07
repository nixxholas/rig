import { describe, expect, it } from "vitest";
import { builtinModelProfiles, type ExecutorProvider } from "@slopus/rig-execution";

import type { AnyDefinedTool } from "../../../agent/types.js";
import { assembleSearchTools } from "../assembleSearchTools.js";
import { createClaudeWebSearchTool } from "../ClaudeWebSearch.js";
import { createCodexWebSearchTool } from "../CodexWebSearch.js";
import { createGrokWebSearchTool } from "../GrokWebSearch.js";
import { createGrokXSearchTool } from "../GrokXSearch.js";
import type { OneOffInferenceRoute, SearchProviderRoutes } from "../OneOffInferenceRoute.js";

const searchFactories: readonly ((options: SearchProviderRoutes) => AnyDefinedTool)[] = [
    createClaudeWebSearchTool,
    createCodexWebSearchTool,
    createGrokWebSearchTool,
    createGrokXSearchTool,
];

describe("search tools", () => {
    it("requires provider_id when multiple matching providers are ambiguous", () => {
        for (const factory of searchFactories) {
            const tool = factory({
                routes: [route("vendor-primary"), route("vendor-secondary")],
            });

            expect(tool.description).toContain("vendor-primary");
            expect(tool.description).toContain("vendor-secondary");
            expect(providerIdSchema(tool).enum).toEqual(["vendor-primary", "vendor-secondary"]);
            expect(requiredArguments(tool)).toContain("provider_id");
        }
    });

    it("makes provider_id optional when the current provider is an available route", () => {
        for (const factory of searchFactories) {
            const tool = factory({
                currentProviderId: "vendor-secondary",
                routes: [route("vendor-primary"), route("vendor-secondary")],
            });

            expect(requiredArguments(tool)).not.toContain("provider_id");
        }
    });

    it("makes provider_id optional when exactly one route exists", () => {
        for (const factory of searchFactories) {
            const tool = factory({ routes: [route("only-provider")] });

            expect(providerIdSchema(tool).enum).toEqual(["only-provider"]);
            expect(requiredArguments(tool)).not.toContain("provider_id");
        }
    });

    it("keeps every vendor definition independent and always includes web_fetch", () => {
        const tools = assembleSearchTools({
            claudeRoutes: [route("claude")],
            codexRoutes: [route("codex")],
            grokRoutes: [route("grok")],
        });

        expect(tools.map((tool) => tool.name)).toEqual([
            "web_fetch",
            "claude_web_search",
            "codex_web_search",
            "grok_web_search",
            "grok_x_search",
        ]);
        expect(new Set(tools.map((tool) => tool.arguments)).size).toBe(tools.length);
    });
});

function route(providerId: string): OneOffInferenceRoute {
    const profile = builtinModelProfiles(providerId, "codex")[0]!;
    const provider: ExecutorProvider = {
        id: providerId,
        native: async () => {
            throw new Error("Inference is not used by this test.");
        },
        profiles: [profile],
    };
    return { profile, provider };
}

function providerIdSchema(tool: AnyDefinedTool): { enum?: readonly string[] } {
    const properties = (tool.arguments as { properties?: Record<string, unknown> }).properties;
    return (properties?.provider_id ?? {}) as { enum?: readonly string[] };
}

function requiredArguments(tool: AnyDefinedTool): readonly string[] {
    return (tool.arguments as { required?: readonly string[] }).required ?? [];
}
