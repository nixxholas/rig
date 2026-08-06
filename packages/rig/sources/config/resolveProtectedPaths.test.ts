import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveProtectedPaths } from "./resolveProtectedPaths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("resolveProtectedPaths", () => {
    it("merges global and project paths and ignores missing entries", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-protected-paths-"));
        temporaryDirectories.push(cwd);
        await Promise.all([
            mkdir(join(cwd, "global")),
            mkdir(join(cwd, "project")),
            writeFile(
                join(cwd, "happy.toml"),
                '[permissions]\nprotected_paths = ["project", "missing-project"]\n',
            ),
        ]);

        expect(resolveProtectedPaths(cwd, ["global", "missing-global"])).toEqual([
            "global",
            "project",
        ]);
    });

    it("protects existing workspace protected sync files", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-protected-sync-"));
        temporaryDirectories.push(cwd);
        await Promise.all([
            writeFile(join(cwd, ".env.production"), "SECRET=1\n"),
            writeFile(
                join(cwd, "happy.toml"),
                '[workspace]\nsync = [".env"]\nprotected_sync = [".env.production", "missing-sync"]\n',
            ),
        ]);

        expect(resolveProtectedPaths(cwd, [])).toEqual([".env.production"]);
    });

    it("prefers rig.toml over happy.toml like the rest of configuration loading", async () => {
        const cwd = await mkdtemp(join(tmpdir(), "rig-protected-precedence-"));
        temporaryDirectories.push(cwd);
        await Promise.all([
            mkdir(join(cwd, "from-rig")),
            mkdir(join(cwd, "from-happy")),
            writeFile(join(cwd, "rig.toml"), '[permissions]\nprotected_paths = ["from-rig"]\n'),
            writeFile(join(cwd, "happy.toml"), '[permissions]\nprotected_paths = ["from-happy"]\n'),
        ]);

        expect(resolveProtectedPaths(cwd, [])).toEqual(["from-rig"]);
    });
});
