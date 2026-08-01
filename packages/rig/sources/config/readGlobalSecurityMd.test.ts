import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GLOBAL_SECURITY_MD_MAX_BYTES } from "./globalSecurityMdMaxBytes.js";
import { readGlobalSecurityMd } from "./readGlobalSecurityMd.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe("readGlobalSecurityMd", () => {
    it("treats missing and blank files as no custom policy", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-global-security-"));
        temporaryDirectories.push(root);
        const path = join(root, "SECURITY.md");

        await expect(readGlobalSecurityMd(path)).resolves.toBeUndefined();
        await writeFile(path, " \n\t");
        await expect(readGlobalSecurityMd(path)).resolves.toBeUndefined();
    });

    it("bounds the policy before adding it to the reviewer prompt", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-global-security-"));
        temporaryDirectories.push(root);
        const path = join(root, "SECURITY.md");
        await writeFile(path, "s".repeat(GLOBAL_SECURITY_MD_MAX_BYTES + 1));

        await expect(readGlobalSecurityMd(path)).resolves.toBe(
            "s".repeat(GLOBAL_SECURITY_MD_MAX_BYTES),
        );
    });
});
