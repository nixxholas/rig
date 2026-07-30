import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    it("creates an owned empty target and removes it with the isolated mount source", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-placeholder-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");

        const placeholder = (await prepareProjectConfigPlaceholder(path))!;

        expect(placeholder.path).toBe(path);
        await expect(readFile(path, "utf8")).resolves.toBe("");
        await expect(readFile(placeholder.sourcePath, "utf8")).resolves.toBe("");
        await placeholder.close();
        await expect(access(placeholder.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("creates independent mount sources for concurrent commands", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-concurrent-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        const gitExcludePath = join(directory, ".git", "info", "exclude");
        await mkdir(join(directory, ".git", "info"), { recursive: true });
        const first = (await prepareProjectConfigPlaceholder(path, gitExcludePath))!;
        const second = (await prepareProjectConfigPlaceholder(path, gitExcludePath))!;

        expect(first.sourcePath).not.toBe(second.sourcePath);
        expect(first.gitExclude?.sourcePath).not.toBe(second.gitExclude?.sourcePath);
        await expect(readFile(path, "utf8")).resolves.toBe("");
        await second.close();
        await expect(readFile(path, "utf8")).resolves.toBe("");
        await expect(readFile(gitExcludePath, "utf8")).resolves.toBe("");
        await first.close();
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(access(gitExcludePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves repository excludes while hiding the synthetic project config", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-exclude-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        const gitExcludePath = join(directory, ".git", "info", "exclude");
        await mkdir(join(directory, ".git", "info"), { recursive: true });
        await writeFile(gitExcludePath, "*.local");

        const placeholder = (await prepareProjectConfigPlaceholder(path, gitExcludePath))!;

        expect(placeholder.gitExclude?.path).toBe(gitExcludePath);
        await expect(readFile(placeholder.gitExclude!.sourcePath, "utf8")).resolves.toBe(
            "*.local\n/rig.toml\n",
        );
        await expect(readFile(gitExcludePath, "utf8")).resolves.toBe("*.local");
        await placeholder.close();
    });

    it("preserves non-UTF-8 repository exclude patterns byte for byte", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-binary-exclude-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        const gitExcludePath = join(directory, ".git", "info", "exclude");
        await mkdir(join(directory, ".git", "info"), { recursive: true });
        await writeFile(gitExcludePath, Buffer.from([0xff]));

        const placeholder = (await prepareProjectConfigPlaceholder(path, gitExcludePath))!;

        await expect(readFile(placeholder.gitExclude!.sourcePath)).resolves.toEqual(
            Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from("/rig.toml\n")]),
        );
        await placeholder.close();
    });

    it("leaves an existing project config untouched and returns no mask", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-existing-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        await writeFile(path, "[network]\n");

        await expect(prepareProjectConfigPlaceholder(path)).resolves.toBeUndefined();
        await expect(readFile(path, "utf8")).resolves.toBe("[network]\n");
    });

    it("preserves a target that the user fills with real configuration", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-preserve-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        const placeholder = (await prepareProjectConfigPlaceholder(path))!;

        await writeFile(path, "[network]\n");
        await placeholder.close();

        await expect(readFile(path, "utf8")).resolves.toBe("[network]\n");
    });

    it("preserves an empty file that replaces the owned target", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-project-config-replaced-"));
        temporaryDirectories.push(directory);
        const path = join(directory, "rig.toml");
        const placeholder = (await prepareProjectConfigPlaceholder(path))!;

        await rm(path);
        await writeFile(path, "");
        await placeholder.close();

        await expect(readFile(path, "utf8")).resolves.toBe("");
    });
});
