import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startHappyAgent, type StartedHappyAgent } from "../../sources/start/startHappyAgent.js";

const started: StartedHappyAgent[] = [];
const directories: string[] = [];

afterEach(async () => {
    for (const agent of started.splice(0)) await agent.close().catch(() => undefined);
    for (const directory of directories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
});

describe("startHappyAgent", () => {
    it("starts every module from nothing but a folder, and names the same root agent twice", async () => {
        const happyHome = await createHappyHome();

        const first = await start(happyHome);
        expect(Object.keys(first.modules).sort()).toEqual([
            "collaboration",
            "compute",
            "config",
            "conversations",
            "events",
            "goal",
            "history",
            "modelSwitch",
            "observation",
            "permissions",
            "presence",
            "scheduling",
            "search",
            "secrets",
            "skills",
            "systemPrompt",
            "tasks",
            "usage",
            "userInput",
        ]);
        expect(first.provider).toBe("codex");
        expect(first.models[0]?.id).toBe("openai/gpt-5.6-terra");
        expect(first.models[0]?.providerId).toBe("codex");
        // The agent works in the public home, which the start created.
        const environment = (await first.system.config(first.ctx, first.agent.id))?.environment;
        expect(environment?.workingDirectory).toBe(first.configuration.paths.publicHome);

        const firstAgentId = first.agent.id;
        await first.close();
        started.length = 0;

        // The same folder is the same installation: restarting resolves the agent, never a new one.
        const second = await start(happyHome);
        expect(second.agent.id).toBe(firstAgentId);
    });

    it("refuses a default model no enabled provider serves", async () => {
        const happyHome = await createHappyHome({ modelId: "openai/not-a-model" });
        await expect(start(happyHome)).rejects.toThrow(/not served by any enabled provider/);
    });

    it("gives its wait tools to the agent without any host supplying them", async () => {
        const happyHome = await createHappyHome();
        const agent = await start(happyHome);
        const toolNames = (await agent.system.tools(agent.ctx, agent.agent.id)).map(
            (tool) => tool.name,
        );
        expect(toolNames).toContain("wait");
        expect(toolNames).toContain("wait_until");
        // Nothing that used to arrive through a host integration is on the agent at all.
        expect(toolNames).not.toContain("generate_image");
    });
});

async function start(happyHome: string): Promise<StartedHappyAgent> {
    const agent = await startHappyAgent({ happyHome, version: "test" });
    started.push(agent);
    return agent;
}

/**
 * A Happy home whose only configured provider is a Codex API key, so starting never reaches for
 * this machine's real credentials.
 */
async function createHappyHome(options: { readonly modelId?: string } = {}): Promise<string> {
    const happyHome = await mkdtemp(join(tmpdir(), "happy-start-"));
    directories.push(happyHome);
    await writeFile(
        join(happyHome, "config.json"),
        JSON.stringify({
            defaults: {
                modelId: options.modelId ?? "openai/gpt-5.6-terra",
                providerId: "codex",
                permissionMode: "read_only",
            },
            providers: {
                codex: {
                    type: "codex",
                    enabled: true,
                    apiKey: "test-key",
                    credentialIsolation: true,
                },
            },
        }),
        "utf8",
    );
    return happyHome;
}
