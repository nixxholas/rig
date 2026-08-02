import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createPluginNodeRuntime } from "../createPluginNodeRuntime.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("the plugin Node runtime", () => {
    it("starts a TypeScript entry point against Rig's runtime SDK without compiling it", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-plugin-runtime-"));
        temporaryDirectories.push(directory);
        const entryPath = join(directory, "index.ts");
        await writeFile(
            entryPath,
            [
                'import { Type } from "happy-plugins";',
                "const message: string = Type.String().type;",
                "console.log(`native:${message}`);",
                "",
            ].join("\n"),
        );

        const runtime = await createPluginNodeRuntime({ entryPath });
        const result = await execFileAsync(runtime.executable, runtime.argv.slice(1), {
            cwd: directory,
            env: {},
        });

        expect(result.stdout).toBe("native:string\n");
        await expect(readdir(directory)).resolves.toEqual(["index.ts"]);
    });
});
