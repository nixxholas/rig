import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareProjectConfigPlaceholder } from "./prepareProjectConfigPlaceholder.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("prepareProjectConfigPlaceholder", () => {
    it("creates one shared empty placeholder and removes only the file it created", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-placeholder-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");

        const owner = await prepareProjectConfigPlaceholder(path);
        const concurrent = await prepareProjectConfigPlaceholder(path);

        expect(owner?.path).toBe(path);
        expect(concurrent).toBeUndefined();
        await expect(readFile(path, "utf8")).resolves.toBe("");
        await owner?.close();
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves a placeholder that the user fills with real configuration", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-preserve-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        const placeholder = await prepareProjectConfigPlaceholder(path);

        await writeFile(path, "[network]\n");
        await placeholder?.close();

        await expect(readFile(path, "utf8")).resolves.toBe("[network]\n");
    });

    it("preserves an empty file that replaces the placeholder", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-replaced-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        const placeholder = await prepareProjectConfigPlaceholder(path);

        await rm(path);
        await writeFile(path, "");
        await placeholder?.close();

        await expect(readFile(path, "utf8")).resolves.toBe("");
    });
});
