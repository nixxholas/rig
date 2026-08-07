import { describe, expect, it } from "vitest";

import { builtinModelProfiles } from "@slopus/rig-execution";
import { createClaudeWebSearchTool, createGeminiWebSearchTool } from "../tools/search/index.js";
import { permissionModeAllowsWebSearch, networkToolPermission } from "./networkToolPermission.js";

describe("the rule every client-executed search answers to", () => {
    it("allows only the modes that already reach outside the workspace", () => {
        expect(permissionModeAllowsWebSearch("auto")).toBe(true);
        expect(permissionModeAllowsWebSearch("full_access")).toBe(true);
        expect(permissionModeAllowsWebSearch("workspace_write")).toBe(false);
        expect(permissionModeAllowsWebSearch("read_only")).toBe(false);
    });

    // A caller with no permission model has established no authority to search, rather than
    // unrestricted authority.
    it("refuses when no permission mode was established", () => {
        expect(permissionModeAllowsWebSearch(undefined)).toBe(false);
    });

    // Restating the rule per tool is how two of them end up disagreeing, so neither restates it.
    it("is the rule both client search tools declare", () => {
        const profile = builtinModelProfiles("claude", "claude")[0]!;
        const route = {
            profile,
            provider: {
                id: "claude",
                native: () => Promise.reject(new Error("unused")),
                profiles: [profile],
            },
        };
        for (const tool of [
            createClaudeWebSearchTool({
                currentProviderId: "claude",
                routes: [route],
            }),
            createGeminiWebSearchTool("test-key"),
        ]) {
            expect(tool.requiresAutoOrFullAccess).toBe(
                networkToolPermission.requiresAutoOrFullAccess,
            );
            expect(tool.shouldReviewInAutoMode?.({} as never, {} as never)).toBe(true);
        }
    });
});
