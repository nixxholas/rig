import { describe, expect, it, vi } from "vitest";

import type { WorkspaceContext } from "../../agent/context/WorkspaceContext.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import {
    addProjectTool,
    archiveWorkspaceTool,
    createWorkspaceTool,
    delegateToWorkspaceTool,
    listProjectsTool,
    listWorkspaceSessionsTool,
    listWorkspacesTool,
    spawnWorkspaceAgentTool,
} from "./workspaceTools.js";
import { transferSessionTool } from "./transfer_session.js";

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
            agentId: "child-agent-1",
            output: "The subagent is running in the background.",
            path: "/root/parser",
            sessionId: "child-1",
            status: "running" as const,
            taskName: "fix_parser",
        }));
        harness.context.workspaces = workspaceContext({ spawn });

        const result = await spawnWorkspaceAgentTool.execute(
            {
                background: true,
                description: "Fix parser",
                model: "openai/gpt-5.6-sol",
                prompt: "Repair the parser and run its tests.",
                reasoning_effort: "medium",
                workspace_id: "workspace-1",
            },
            harness.context,
            { toolCallId: "tool-1" },
        );

        expect(result).toEqual({
            agentId: "child-agent-1",
            output: "The subagent is running in the background.",
            path: "/root/parser",
            status: "running",
        });
        expect(spawn).toHaveBeenCalledWith(
            {
                background: true,
                contextMode: "task",
                description: "Fix parser",
                effort: "medium",
                modelId: "openai/gpt-5.6-sol",
                parentToolCallId: "tool-1",
                prompt: "Repair the parser and run its tests.",
                workspaceId: "workspace-1",
            },
            undefined,
        );
    });

    it("passes workspace-agent overrides and parent context to the child", async () => {
        const harness = createJustBashToolHarness();
        const spawn = vi.fn(async () => ({
            agentId: "child-agent-1",
            output: "The subagent is running in the background.",
            path: "/root/parser",
            sessionId: "child-1",
            status: "running" as const,
            taskName: "fix_parser",
        }));
        harness.context.workspaces = workspaceContext({ spawn });

        await spawnWorkspaceAgentTool.execute(
            {
                context: "parent",
                description: "Fix parser",
                model: "openai/gpt-5.6-sol",
                prompt: "Repair the parser and run its tests.",
                provider: "codex",
                read_only: true,
                reasoning_effort: "high",
                service_tier: "priority",
                workspace_id: "workspace-1",
            },
            harness.context,
            {
                messages: [
                    {
                        blocks: [{ type: "text", text: "Prior task" }],
                        id: "message-1",
                        role: "user",
                    },
                    {
                        blocks: [{ type: "text", text: "Current task" }],
                        id: "message-2",
                        role: "user",
                    },
                ],
            },
        );

        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
                contextMessages: [
                    {
                        blocks: [{ type: "text", text: "Prior task" }],
                        id: "message-1",
                        role: "user",
                    },
                ],
                contextMode: "parent",
                effort: "high",
                modelId: "openai/gpt-5.6-sol",
                providerId: "codex",
                readOnly: true,
                serviceTier: "fast",
            }),
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

    it("keeps project listing behind the cross-workspace setting", () => {
        const harness = createJustBashToolHarness();
        harness.context.workspaces = workspaceContext({});

        expect(() => listProjectsTool.execute({}, harness.context, {})).toThrow(
            "features.cross_workspace",
        );
    });

    it("adds projects through the reviewed cross-workspace action", async () => {
        const harness = createJustBashToolHarness();
        const addProject = vi.fn(async () => ({
            current: false,
            id: "project-2",
            name: "Another project",
            path: "/projects/another",
        }));
        harness.context.workspaces = workspaceContext({ addProject, crossWorkspace: true });

        await expect(
            addProjectTool.execute({ path: "/projects/another" }, harness.context, {}),
        ).resolves.toMatchObject({ id: "project-2", path: "/projects/another" });
        expect(addProject).toHaveBeenCalledWith("/projects/another");
        expect(addProjectTool.requiresAutoOrFullAccess).toBe(true);
        expect(
            addProjectTool.shouldReviewInAutoMode({ path: "/projects/another" }, harness.context),
        ).toBe(true);
        expect(
            addProjectTool.shouldRunInFullAccessInAutoMode(
                { path: "/projects/another" },
                harness.context,
            ),
        ).toBe(true);
    });

    it("delegates within the current project without cross-workspace access", async () => {
        const harness = createJustBashToolHarness();
        const delegate = vi.fn(async () => ({
            agentId: "agent-2",
            projectId: "project-1",
            sessionId: "session-2",
            title: "Update the changelog",
            workspaceId: "workspace-2",
            workspacePath: "/workspaces/changelog",
        }));
        harness.context.workspaces = workspaceContext({ delegate });

        await expect(
            delegateToWorkspaceTool.execute(
                {
                    model: "openai/gpt-5.6-sol",
                    prompt: "Update the changelog.",
                    reasoning_effort: "medium",
                    workspace_id: "workspace-2",
                },
                harness.context,
                {},
            ),
        ).resolves.toMatchObject({ agentId: "agent-2", projectId: "project-1" });
        expect(delegate).toHaveBeenCalledWith({
            effort: "medium",
            modelId: "openai/gpt-5.6-sol",
            prompt: "Update the changelog.",
            workspaceId: "workspace-2",
        });
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
                    model: "openai/gpt-5.6-sol",
                    provider: "codex",
                    reasoning_effort: "high",
                    read_only: true,
                    service_tier: "priority",
                    title: "Update the changelog",
                    workspace_id: "workspace-2",
                },
                harness.context,
                {},
            ),
        ).resolves.toMatchObject({ agentId: "agent-2", sessionId: "session-2" });
        expect(delegate).toHaveBeenCalledWith({
            effort: "high",
            modelId: "openai/gpt-5.6-sol",
            prompt: "Update the changelog.",
            providerId: "codex",
            readOnly: true,
            serviceTier: "fast",
            title: "Update the changelog",
            workspaceId: "workspace-2",
        });
    });

    it("tells the user that delegation leaves this conversation's workspace", () => {
        expect(
            delegateToWorkspaceTool.describeAutoPermissionAction?.(
                {
                    model: "openai/gpt-5.6-sol",
                    prompt: "Update the changelog.",
                    provider: "codex",
                    reasoning_effort: "medium",
                    workspace_id: "workspace-2",
                },
                createJustBashToolHarness().context,
            ),
        ).toContain("outside this conversation's own workspace");
    });

    it("schedules a transfer with destructive target and overlay behavior disclosed", async () => {
        const harness = createJustBashToolHarness();
        const result = {
            state: "scheduled" as const,
            targetWorkspaceId: "workspace-2",
        };
        const transfer = vi.fn(async () => result);
        harness.context.workspaces = workspaceContext({ transfer });

        await expect(
            transferSessionTool.execute(
                { target_workspace_id: "workspace-2" },
                harness.context,
                {},
            ),
        ).resolves.toEqual(result);
        expect(transfer).toHaveBeenCalledWith("workspace-2");
        expect(transferSessionTool.description).toContain(".happyignore");
        expect(transferSessionTool.description).toContain("working-tree regular-file");
        expect(transferSessionTool.description).toContain("all local working state are discarded");
        expect(transferSessionTool.description).toContain(
            "Subagents spawned earlier remain in the previous workspace",
        );
        expect(transferSessionTool.locks).toEqual([]);
        expect(
            transferSessionTool.describeAutoPermissionAction?.(
                {
                    target_workspace_id: "workspace-2",
                },
                harness.context,
            ),
        ).toContain("discarding");
        expect(transferSessionTool.toLLM(result)[0]).toMatchObject({
            text: expect.stringContaining("further filesystem changes"),
        });
    });
});

function workspaceContext(overrides: Partial<WorkspaceContext>): WorkspaceContext {
    return {
        addProject: vi.fn(),
        archive: vi.fn(),
        create: vi.fn(),
        crossWorkspace: false,
        delegate: vi.fn(),
        listProjects: vi.fn(() => []),
        listSessions: vi.fn(() => []),
        listWorkspaces: vi.fn(() => []),
        spawn: vi.fn(),
        transfer: vi.fn(),
        ...overrides,
    } as WorkspaceContext;
}

function workspace() {
    return {
        archived: false,
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
        archived: false,
        id: "session-1",
        agentId: "agent-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        title: "Investigate parser",
        status: "idle",
        updatedAt: 1,
    };
}
