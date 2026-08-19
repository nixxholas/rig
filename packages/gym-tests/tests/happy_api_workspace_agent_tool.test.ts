import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("workspace creation through the agent tool", () => {
    it("provisions the reserved workspace after the transactional tool call commits", async () => {
        let projectId = "";
        let createIssued = false;
        const gym = await createAgentGym({
            files: { "workspace-tool-marker.txt": "created through the agent tool\n" },
            inference: (_request: GymInferenceRequest): GymTurn => {
                if (!createIssued) {
                    createIssued = true;
                    return {
                        content: [
                            {
                                arguments: {
                                    name: "Agent tool workspace",
                                    projectRef: projectId,
                                },
                                callId: "call_workspace_agent_tool",
                                name: "create_workspace",
                                type: "tool_call",
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            text: "The workspace was reserved and its setup is continuing.",
                            type: "text",
                        },
                    ],
                };
            },
        });
        running.add(gym);

        const project = (await gym.client.listProjects()).projects.find((candidate) =>
            candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
        );
        expect(project).toBeDefined();
        if (project === undefined) throw new Error("The gym did not register its root project.");
        projectId = project.id;

        await gym.send("Create a workspace with the workspace tool.");

        const workspace = await gym.waitUntil(async () => {
            const candidate = (
                await gym.client.listWorkspaces({
                    includeArchived: true,
                    projectId,
                })
            ).workspaces.find((item) => item.name === "Agent tool workspace");
            return candidate?.initialization.status === "ready" ? candidate : undefined;
        }, "the agent-tool workspace to become ready");

        expect(workspace).toMatchObject({
            creatorAgentId: gym.defaultSessionId,
            initialization: { error: null, status: "ready" },
            parentId: projectId,
            projectId,
        });
        expect(workspace.compute.type).toBe("host");
        if (workspace.compute.type !== "host") {
            throw new Error("The agent-tool workspace did not receive a host folder.");
        }
        await expect(
            readFile(join(workspace.compute.path, "workspace-tool-marker.txt"), "utf8"),
        ).resolves.toBe("created through the agent tool\n");
        expect(
            gym.inference
                .toolResults()
                .some((result) => result.callId === "call_workspace_agent_tool"),
        ).toBe(true);
    }, 30_000);
});
