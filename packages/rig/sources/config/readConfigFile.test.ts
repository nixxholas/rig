import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readConfigFile } from "./readConfigFile.js";

describe("readConfigFile", () => {
    it("treats a path below a non-directory ancestor as missing", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-missing-config-"));
        const blockedDirectory = join(root, "Happy");
        await writeFile(blockedDirectory, "not a directory\n");
        const path = join(blockedDirectory, "Config", "happy.toml");

        try {
            await expect(readConfigFile(path)).resolves.toEqual({
                exists: false,
                path,
                values: {},
            });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
