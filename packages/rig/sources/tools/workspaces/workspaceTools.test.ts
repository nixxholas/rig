import { describe, expect, it, vi } from "vitest";

import type { WorkspaceContext } from "../../agent/context/WorkspaceContext.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import {
    archiveWorkspaceTool,
    createWorkspaceTool,
    delegateToWorkspaceTool,
    listProjectsTool,
    listWorkspaceSessionsTool,
    listWorkspacesTool,
    spawnWorkspaceAgentTool,
} from "./workspaceTools.js";

describe("workspace tools", () => {
    it("creates a workspace through the session-owned context", async () => {
        const harness = createJustBashToolHarness();
        const create = vi.fn(async () => workspace());
        harness.context.workspaces = workspaceContext({ create });

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

    it("leaves the base to the project when the model names none", async () => {
        const harness = createJustBashToolHarness();
        const create = vi.fn(async () => workspace());
        harness.context.workspaces = workspaceContext({ create });

        await createWorkspaceTool.execute({ name: "Investigate parser" }, harness.context, {});

        expect(create).toHaveBeenCalledWith({ name: "Investigate parser" });
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
        harness.context.workspaces = workspaceContext({ spawn });

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

    it("lists the workspaces and conversations the session can reach", () => {
        const harness = createJustBashToolHarness();
        const listWorkspaces = vi.fn(() => [workspace()]);
        const listSessions = vi.fn(() => [session()]);
        harness.context.workspaces = workspaceContext({ listSessions, listWorkspaces });

        expect(listWorkspacesTool.execute({}, harness.context, {})).toEqual({
            workspaces: [workspace()],
        });
        expect(listWorkspaces).toHaveBeenCalledWith(undefined);
        expect(
            listWorkspaceSessionsTool.execute({ workspace_id: "workspace-1" }, harness.context, {}),
        ).toEqual({ sessions: [session()] });
        expect(listSessions).toHaveBeenCalledWith({ workspaceId: "workspace-1" });
    });

    it("keeps projects and delegation behind the cross-workspace setting", () => {
        const harness = createJustBashToolHarness();
        harness.context.workspaces = workspaceContext({});

        expect(() => listProjectsTool.execute({}, harness.context, {})).toThrow(
            "features.cross_workspace",
        );
        expect(() =>
            delegateToWorkspaceTool.execute(
                { prompt: "Update the changelog.", workspace_id: "workspace-2" },
                harness.context,
                {},
            ),
        ).toThrow("features.cross_workspace");
    });

    it("delegates a visible conversation once cross-workspace work is allowed", async () => {
        const harness = createJustBashToolHarness();
        const delegate = vi.fn(async () => ({
            agentId: "agent-2",
            projectId: "project-1",
            sessionId: "session-2",
            title: "Update the changelog",
            workspaceId: "workspace-2",
            workspacePath: "/workspaces/changelog",
        }));
        harness.context.workspaces = workspaceContext({ crossWorkspace: true, delegate });

        await expect(
            delegateToWorkspaceTool.execute(
                {
                    prompt: "Update the changelog.",
                    title: "Update the changelog",
                    workspace_id: "workspace-2",
                },
                harness.context,
                {},
            ),
        ).resolves.toMatchObject({ agentId: "agent-2", sessionId: "session-2" });
        expect(delegate).toHaveBeenCalledWith({
            prompt: "Update the changelog.",
            title: "Update the changelog",
            workspaceId: "workspace-2",
        });
    });

    it("tells the user that delegation leaves this conversation's workspace", () => {
        expect(
            delegateToWorkspaceTool.describeAutoPermissionAction?.(
                { prompt: "Update the changelog.", workspace_id: "workspace-2" },
                createJustBashToolHarness().context,
            ),
        ).toContain("outside this conversation's own workspace");
    });
});

function workspaceContext(overrides: Partial<WorkspaceContext>): WorkspaceContext {
    return {
        archive: vi.fn(),
        create: vi.fn(),
        crossWorkspace: false,
        delegate: vi.fn(),
        listProjects: vi.fn(() => []),
        listSessions: vi.fn(() => []),
        listWorkspaces: vi.fn(() => []),
        spawn: vi.fn(),
        ...overrides,
    } as WorkspaceContext;
}

function workspace() {
    return {
        id: "workspace-1",
        name: "Investigate parser",
        path: "/workspaces/parser",
        projectId: "project-1",
        status: "ready" as const,
        owned: true,
    };
}

function session() {
    return {
        id: "session-1",
        agentId: "agent-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        title: "Investigate parser",
        status: "idle",
        updatedAt: 1,
    };
}
