import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkletNodeRuntime } from "../createWorkletNodeRuntime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("worklet Node runtime", () => {
    it("loads the shipped SDK and transforms TypeScript enums and parameter properties", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-worklet-runtime-"));
        temporaryDirectories.push(directory);
        const entryPath = join(directory, "index.ts");
        const outputPath = join(directory, "result.txt");
        await writeFile(
            entryPath,
            `
                import { writeFile } from "node:fs/promises";
                import { Type } from "happy-worklets";

                enum Phase {
                    Ready = "ready",
                }

                class State {
                    constructor(readonly phase: Phase) {}
                }

                const schema = Type.Object({ phase: Type.String() });
                await writeFile(
                    ${JSON.stringify(outputPath)},
                    new State(Phase.Ready).phase + ":" + schema.type,
                );
            `,
        );

        const runtime = await createWorkletNodeRuntime({ entryPath });
        const result = await run(runtime.executable, runtime.argv.slice(1), directory);

        expect(result).toEqual({ code: 0, stderr: "" });
        await expect(readFile(outputPath, "utf8")).resolves.toBe("ready:object");
    });
});

function run(
    executable: string,
    args: readonly string[],
    cwd: string,
): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd,
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
    });
}
