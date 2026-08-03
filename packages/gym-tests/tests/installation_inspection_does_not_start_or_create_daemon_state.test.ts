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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const child = spawn(
    process.execPath,
    ${JSON.stringify(["--import", sourceHook, rigMain, "inspect", "--json"])},
    { env: process.env, stdio: "inherit" },
);
const result = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
const childPid = child.pid;
let orphanProcess = false;
if (childPid !== undefined) {
    try {
        process.kill(childPid, 0);
        orphanProcess = true;
    } catch (error) {
        if (error?.code !== "ESRCH") throw error;
    }
}
const directory = resolve(process.env.RIG_SERVER_DIRECTORY);
const statePaths = [
    directory + "/server.sock",
    directory + "/server.json",
    directory + "/server.log",
    directory + "/token",
    directory + "/sessions.sqlite",
    directory + "/sessions.sqlite.lock",
];
const cleanState = {
    daemonDirectory: existsSync(directory),
    daemonStatePaths: statePaths.filter(existsSync),
};
mkdirSync(directory);
writeFileSync(directory + "/sessions.sqlite", "not a SQLite database");
const unavailableChild = spawn(
    process.execPath,
    ${JSON.stringify(["--import", sourceHook, rigMain, "inspect", "--json"])},
    { env: process.env, stdio: "inherit" },
);
const unavailableResult = await new Promise((resolve) =>
    unavailableChild.once("exit", (code, signal) => resolve({ code, signal })),
);
let unavailableOrphanProcess = false;
if (unavailableChild.pid !== undefined) {
    try {
        process.kill(unavailableChild.pid, 0);
        unavailableOrphanProcess = true;
    } catch (error) {
        if (error?.code !== "ESRCH") throw error;
    }
}
rmSync(directory, { force: true, recursive: true });
const proof = {
    childExitCode: result.code,
    childSignal: result.signal,
    ...cleanState,
    orphanProcess,
    unavailableExitCode: unavailableResult.code,
    unavailableOrphanProcess,
    unavailableSignal: unavailableResult.signal,
};
console.log("INSPECTION_PROOF " + JSON.stringify(proof));
for (const [name, value] of Object.entries(proof)) {
    console.log("PROOF " + name + "=" + JSON.stringify(value));
}
if (
    proof.childExitCode !== 0 ||
    proof.childSignal !== null ||
    proof.daemonDirectory ||
    proof.daemonStatePaths.length > 0 ||
    proof.orphanProcess ||
    proof.unavailableExitCode !== 2 ||
    proof.unavailableSignal !== null ||
    proof.unavailableOrphanProcess
) process.exit(1);
setInterval(() => {}, 60_000);
`;
        const gym = await createGym({
            entrypoint: [process.execPath, "run-inspection.mjs"],
            environment: { RIG_SERVER_DIRECTORY: "daemon-state" },
            files: { "run-inspection.mjs": wrapper },
            startupText: "INSPECTION_PROOF",
        });
        running.add(gym);

        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain('"cliVersion"');
        expect(screen.text).toContain('"cliProtocolVersion"');
        expect(screen.text).toContain('"status":"absent"');
        expect(screen.text).toContain("PROOF childExitCode=0");
        expect(screen.text).toContain("PROOF childSignal=null");
        expect(screen.text).toContain("PROOF daemonDirectory=false");
        expect(screen.text).toContain("PROOF daemonStatePaths=[]");
        expect(screen.text).toContain("PROOF orphanProcess=false");
        expect(screen.text).toContain("PROOF unavailableExitCode=2");
        expect(screen.text).toContain("PROOF unavailableSignal=null");
        expect(screen.text).toContain("PROOF unavailableOrphanProcess=false");
    });
});
