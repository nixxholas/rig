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

const inspectionArguments = ${JSON.stringify(["--import", sourceHook, rigMain, "inspect", "--json"])};

async function runInspection() {
    const child = spawn(process.execPath, inspectionArguments, {
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
        process.stdout.write(chunk);
    });
    const result = await new Promise((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    return { child, payload: JSON.parse(stdout.trim()), result };
}

function processSurvived(child) {
    if (child.pid === undefined) return false;
    try {
        process.kill(child.pid, 0);
        return true;
    } catch (error) {
        if (error?.code !== "ESRCH") throw error;
        return false;
    }
}

const cleanInspection = await runInspection();
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
const unavailableInspection = await runInspection();
rmSync(directory, { force: true, recursive: true });
const proof = {
    childExitCode: cleanInspection.result.code,
    childSignal: cleanInspection.result.signal,
    cliProtocolVersionIsInteger: Number.isInteger(cleanInspection.payload.cliProtocolVersion),
    cliVersionIsString: typeof cleanInspection.payload.cliVersion === "string",
    ...cleanState,
    inspectionStatus: cleanInspection.payload.data.status,
    orphanProcess: processSurvived(cleanInspection.child),
    unavailableExitCode: unavailableInspection.result.code,
    unavailableOrphanProcess: processSurvived(unavailableInspection.child),
    unavailableSignal: unavailableInspection.result.signal,
    unavailableStatus: unavailableInspection.payload.data.status,
};
console.log("INSPECTION_PROOF " + JSON.stringify(proof));
for (const [name, value] of Object.entries(proof)) {
    console.log("PROOF " + name + "=" + JSON.stringify(value));
}
if (
    proof.childExitCode !== 0 ||
    proof.childSignal !== null ||
    !proof.cliProtocolVersionIsInteger ||
    !proof.cliVersionIsString ||
    proof.daemonDirectory ||
    proof.daemonStatePaths.length > 0 ||
    proof.inspectionStatus !== "absent" ||
    proof.orphanProcess ||
    proof.unavailableExitCode !== 2 ||
    proof.unavailableSignal !== null ||
    proof.unavailableOrphanProcess ||
    proof.unavailableStatus !== "unavailable"
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
        expect(screen.text).toContain("PROOF childExitCode=0");
        expect(screen.text).toContain("PROOF childSignal=null");
        expect(screen.text).toContain("PROOF cliProtocolVersionIsInteger=true");
        expect(screen.text).toContain("PROOF cliVersionIsString=true");
        expect(screen.text).toContain("PROOF daemonDirectory=false");
        expect(screen.text).toContain("PROOF daemonStatePaths=[]");
        expect(screen.text).toContain('PROOF inspectionStatus="absent"');
        expect(screen.text).toContain("PROOF orphanProcess=false");
        expect(screen.text).toContain("PROOF unavailableExitCode=2");
        expect(screen.text).toContain("PROOF unavailableSignal=null");
        expect(screen.text).toContain("PROOF unavailableOrphanProcess=false");
        expect(screen.text).toContain('PROOF unavailableStatus="unavailable"');
    });
});
