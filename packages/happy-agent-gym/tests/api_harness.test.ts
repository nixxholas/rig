import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym, clientFrameEvent } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("the public API gym harness", () => {
    it("drives the typed client over UDS, records SSE, restarts, and cleans up", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const root = gym.happyHome.slice(0, gym.happyHome.lastIndexOf("/"));
        const stream = gym.stream();
        await stream.opened();

        await expect(gym.client.getGreeting()).resolves.toMatchObject({
            text: "Welcome to Happy Agent!",
        });
        await expect(gym.client.getHealth()).resolves.toMatchObject({
            ready: true,
        });

        const childPath = join(gym.workspacePath, "registered-folder");
        await mkdir(childPath);
        const registered = await gym.client.registerProject({ path: childPath });
        const created = await gym.client.createAgent({
            workspaceId: registered.project.id,
        });
        const agentEvent = await stream.waitFor(
            (frame) => clientFrameEvent(frame)?.type === "agent.created",
            "the created agent event",
        );
        expect(clientFrameEvent(agentEvent)).toMatchObject({
            payload: { agent: { id: created.agent.id, workspaceId: registered.project.id } },
        });

        await gym.restart();
        const projects = await gym.client.listProjects();
        expect(projects.projects.map((project) => project.id)).toContain(registered.project.id);

        stream.close();
        await gym.dispose();
        running.delete(gym);
        await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    });
});
