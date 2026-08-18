import { existsSync } from "node:fs";
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
            "happy",
            "history",
            "imageGeneration",
            "modelSwitch",
            "murmur",
            "observation",
            "permissions",
            "presence",
            "profile",
            "projects",
            "scheduling",
            "search",
            "secrets",
            "skills",
            "systemPrompt",
            "tasks",
            "terminals",
            "titles",
            "usage",
            "userInput",
            "workflows",
            "workspaces",
        ]);
        expect(first.provider).toBe("codex");
        expect(first.models[0]?.id).toBe("openai/gpt-5.6-terra");
        expect(first.models[0]?.providerId).toBe("codex");
        // The start creates the public home every session works out of by default.
        expect(existsSync(first.configuration.paths.publicHome)).toBe(true);

        const firstEpoch = first.installation.epoch;
        await first.close();
        started.length = 0;

        // The same folder is the same installation: restarting keeps the epoch it was started with.
        const second = await start(happyHome);
        expect(second.installation.epoch).toBe(firstEpoch);
    });

    it("refuses a default model no enabled provider serves", async () => {
        const happyHome = await createHappyHome({ modelId: "openai/not-a-model" });
        await expect(start(happyHome)).rejects.toThrow(/not served by any enabled provider/);
    });

    it("connects Happy as its one host-backed module and needs no other integration", async () => {
        const agent = await start(await createHappyHome());
        const names = Object.keys(agent.modules);
        // Happy is the one module that speaks to something outside this process — the phone. It is
        // wired in from the same start as everything else, through a host the daemon builds itself,
        // so it is present here rather than injected from outside.
        expect(names).toContain("happy");
        // MCP is still not one of the daemon's modules.
        expect(names).not.toContain("mcp");
        // Image generation asks no host for anything: it reads the configured Codex account itself.
        expect(agent.modules.imageGeneration.accountCount).toBe(1);
        // Workflows run here too, on the collaboration module rather than an injected runtime.
        expect(agent.modules.workflows.name).toBe("workflows");
        // Everything the daemon serves over its socket comes from the same start, with no host.
        expect(typeof agent.background).toBe("function");
        expect(agent.git.name).toBe("git");
        // The catalogs do their own Git, folders and clones, so there is no service between them
        // and the disk any more — only the installation they were opened for.
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
