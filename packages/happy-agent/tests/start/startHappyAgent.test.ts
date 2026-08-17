import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
            "imageGeneration",
            "modelSwitch",
            "observation",
            "permissions",
            "presence",
            "projects",
            "scheduling",
            "search",
            "secrets",
            "skills",
            "systemPrompt",
            "tasks",
            "usage",
            "userInput",
            "workspaces",
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
        expect(second.installation.epoch).toBe(first.installation.epoch);
    });

    it("refuses a default model no enabled provider serves", async () => {
        const happyHome = await createHappyHome({ modelId: "openai/not-a-model" });
        await expect(start(happyHome)).rejects.toThrow(/not served by any enabled provider/);
    });

    it("has no module that would need a host integration", async () => {
        const agent = await start(await createHappyHome());
        const names = Object.keys(agent.modules);
        for (const absent of ["happy", "mcp", "workflows"]) {
            expect(names).not.toContain(absent);
        }
        // Image generation asks no host for anything: it reads the configured Codex account itself.
        expect(agent.modules.imageGeneration.accountCount).toBe(1);
        // Everything the daemon serves over its socket comes from the same start, with no host.
        expect(typeof agent.background).toBe("function");
        expect(agent.gitTracker).toBeDefined();
        expect(agent.projectWorkspaces).toBeDefined();
        expect(agent.installation.schemaVersion).toBe(1);
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
    const root = await mkdtemp(join(tmpdir(), "happy-start-"));
    directories.push(root);
    const happyHome = join(root, ".happy");
    await mkdir(join(root, "Happy", "Config"), { recursive: true });
    await writeFile(
        join(root, "Happy", "Config", "happy.toml"),
        [
            "[defaults]",
            `model = "${options.modelId ?? "openai/gpt-5.6-terra"}"`,
            'provider = "codex"',
            'permission_mode = "read_only"',
            "",
            "[providers.codex]",
            'type = "codex"',
            "enabled = true",
            'api_key = "test-key"',
            "credential_isolation = true",
            "",
        ].join("\n"),
        "utf8",
    );
    return happyHome;
}
