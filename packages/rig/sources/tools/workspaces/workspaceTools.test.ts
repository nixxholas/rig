import { describe, expect, it, vi } from "vitest";

import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import {
    archiveWorkspaceTool,
    createWorkspaceTool,
    spawnWorkspaceAgentTool,
} from "./workspaceTools.js";

describe("workspace tools", () => {
    it("creates a workspace through the session-owned context", async () => {
        const harness = createJustBashToolHarness();
        const create = vi.fn(async () => workspace());
        harness.context.workspaces = {
            archive: vi.fn(),
            create,
            spawn: vi.fn(),
        };

        await expect(
            createWorkspaceTool.execute(
                { base_ref: "main", name: "Investigate parser" },
                harness.context,
                {},
            ),
        ).resolves.toEqual(workspace());
        expect(create).toHaveBeenCalledWith({
            baseRef: "main",
            name: "Investigate parser",
        });
    });

    it("starts a hidden subagent in the selected owned workspace", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            output: "The subagent is running in the background.",
            path: "/root/parser",
            sessionId: "child-1",
            status: "running" as const,
            taskName: "fix_parser",
        }));
        harness.context.workspaces = {
            archive: vi.fn(),
            create: vi.fn(),
            spawn,
        };

        await spawnWorkspaceAgentTool.execute(
            {
                background: true,
                description: "Fix parser",
                prompt: "Repair the parser and run its tests.",
                workspace_id: "workspace-1",
            },
            harness.context,
            { toolCallId: "tool-1" },
        );

        expect(spawn).toHaveBeenCalledWith(
            {
                background: true,
                description: "Fix parser",
                parentToolCallId: "tool-1",
                prompt: "Repair the parser and run its tests.",
                workspaceId: "workspace-1",
            },
            undefined,
        );
    });

    it("cannot archive without the primary session ownership context", async () => {
        const harness = createJustBashToolHarness();
        expect(() =>
            archiveWorkspaceTool.execute(
                { workspace_id: "someone-elses-workspace" },
                harness.context,
                {},
            ),
        ).toThrow("only available in a primary session");
    });
});

function workspace() {
    return {
        id: "workspace-1",
        name: "Investigate parser",
        path: "/workspaces/parser",
        status: "ready" as const,
    };
}
