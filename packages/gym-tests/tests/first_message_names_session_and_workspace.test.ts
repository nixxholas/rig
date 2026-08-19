import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("first-message naming", () => {
    it("names an untitled session before its first real inference", async () => {
        const gym = await startGym();

        expect((await gym.client.getAgent(gym.defaultSessionId)).agent.title).toBeNull();

        await gym.send("Investigate why the project file list is empty.");

        const named = await gym.waitUntil(async () => {
            const agent = (await gym.client.getAgent(gym.defaultSessionId)).agent;
            return agent.title === null ? undefined : agent;
        }, "the first message to name its session");
        expect(named.title).toBe("Project file list investigation");

        const requests = gym.inference.requests;
        expect(requests[0]?.instructions).toContain("You name a piece of work");
        expect(JSON.stringify(requests[1]?.messages)).toContain(
            "Investigate why the project file list is empty.",
        );
    }, 30_000);

    it("renames an API-created placeholder workspace from its first message", async () => {
        const gym = await startGym();
        const root = await rootWorkspace(gym);
        const placeholder = (
            await gym.client.createWorkspace({
                mutationId: "first-message-placeholder-workspace",
                name: "Workspace",
                nameConfigured: false,
                parentId: root.id,
            } as Parameters<AgentGym["client"]["createWorkspace"]>[0] & {
                readonly nameConfigured: false;
            })
        ).workspace;
        await gym.waitUntil(async () => {
            const workspace = (await gym.client.getWorkspace(placeholder.id)).workspace;
            return workspace.initialization.status === "ready" ? workspace : undefined;
        }, "the placeholder workspace to become ready");
        expect((await gym.client.getWorkspace(placeholder.id)).workspace.nameSource).toBe(
            "generated",
        );

        const agent = (
            await gym.client.createAgent({
                id: "firstmessageworkspaceagent",
                mutationId: "first-message-workspace-agent",
                workspaceId: placeholder.id,
            })
        ).agent;
        await gym.send("Investigate why the project file list is empty.", {
            sessionId: agent.id,
        });

        const renamed = await gym.waitUntil(async () => {
            const workspace = (await gym.client.getWorkspace(placeholder.id)).workspace;
            return workspace.name === "project-file-list" ? workspace : undefined;
        }, "the first message to name its workspace");
        expect(renamed.nameSource).toBe("generated");
        expect((await gym.client.getAgent(agent.id)).agent.title).toBe(
            "Project file list investigation",
        );
    }, 30_000);
});

async function startGym(): Promise<AgentGym> {
    const gym = await createAgentGym({
        inference: (request) => {
            if (request.instructions.includes("You name a piece of work")) {
                return {
                    content: [
                        {
                            text: [
                                "<title>Project file list investigation</title>",
                                "<slug>project-file-list</slug>",
                            ].join("\n"),
                            type: "text",
                        },
                    ],
                };
            }
            return { content: [{ text: "Investigation complete.", type: "text" }] };
        },
    });
    activeGyms.add(gym);
    return gym;
}

async function rootWorkspace(gym: AgentGym) {
    const project = (await gym.client.listProjects()).projects.find((candidate) =>
        candidate.agents.some((agent) => agent.id === gym.defaultSessionId),
    );
    if (project === undefined) throw new Error("The gym did not expose its root project.");
    return await gym.waitUntil(async () => {
        try {
            const workspace = (await gym.client.getWorkspace(project.id)).workspace;
            return workspace.initialization.status === "ready" ? workspace : undefined;
        } catch (error) {
            if ((error as { readonly status?: unknown }).status === 409) return undefined;
            throw error;
        }
    }, "the root workspace to become ready");
}
