import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/rig-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("installation inspection does not start or create daemon state", () => {
    it("exits after reporting an absent installation without creating the daemon directory", async () => {
        const repositoryRoot = resolve(import.meta.dirname, "../../..");
        const sourceHook = join(
            repositoryRoot,
            "packages/gym/sources/registerTypeScriptSourceHooks.mjs",
        );
        const rigMain = join(repositoryRoot, "packages/rig/sources/main.ts");
        const wrapper = `
import { spawn } from "node:child_process";

const child = spawn(
    process.execPath,
    ${JSON.stringify(["--import", sourceHook, rigMain, "inspect", "--json"])},
    { env: process.env, stdio: "inherit" },
);
const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
if (result.code !== 0) process.exit(result.code ?? 1);
setInterval(() => {}, 60_000);
`;
        const gym = await createGym({
            entrypoint: [process.execPath, "run-inspection.mjs"],
            environment: { RIG_SERVER_DIRECTORY: "/workspace/daemon-state" },
            files: { "run-inspection.mjs": wrapper },
            startupText: '"status":"absent"',
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain('"rigVersion"');
        expect(screen.text).toContain('"protocolVersion"');
        expect(screen.text).toContain('"status":"absent"');
        expect(existsSync(join(gym.workspacePath, "daemon-state"))).toBe(false);
    });
});
