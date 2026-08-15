import { access, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareHostProjectConfigPlaceholders } from "../../../sources/host/impl/prepareHostProjectConfigPlaceholders.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("prepareHostProjectConfigPlaceholders", () => {
    it("keeps a shared absent policy reserved until every command releases it", async () => {
        const root = await mkdtemp(join(tmpdir(), "host-policy-placeholder-"));
        temporaryDirectories.push(root);
        const path = join(root, "agent-policy.toml");

        const [first, second] = await Promise.all([
            prepareHostProjectConfigPlaceholders([path]),
            prepareHostProjectConfigPlaceholders([path]),
        ]);

        expect(first).toHaveLength(1);
        expect(second).toHaveLength(1);
        await expect(readFile(path, "utf8")).resolves.toBe("");

        await first[0]!.close();
        await expect(access(path)).resolves.toBeUndefined();
        await second[0]!.close();
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves a policy file filled while its placeholder is active", async () => {
        const root = await mkdtemp(join(tmpdir(), "host-policy-placeholder-filled-"));
        temporaryDirectories.push(root);
        const path = join(root, "agent-policy.toml");

        const [placeholder] = await prepareHostProjectConfigPlaceholders([path]);
        await writeFile(path, "[network]\n");

        await placeholder!.close();
        await expect(readFile(path, "utf8")).resolves.toBe("[network]\n");
    });

    it("preserves a placeholder whose content was written and then truncated", async () => {
        const root = await mkdtemp(join(tmpdir(), "host-policy-placeholder-truncated-"));
        temporaryDirectories.push(root);
        const path = join(root, "agent-policy.toml");

        const [placeholder] = await prepareHostProjectConfigPlaceholders([path]);
        await writeFile(path, "temporary content");
        await truncate(path, 0);

        await placeholder!.close();
        await expect(readFile(path, "utf8")).resolves.toBe("");
    });
});
