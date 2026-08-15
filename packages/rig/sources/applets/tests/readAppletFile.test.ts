import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readAppletFile } from "../readAppletFile.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("readAppletFile", () => {
    it("serves only safe paths inside the requested version", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-applet-files-"));
        cleanups.push(() => rm(root, { force: true, recursive: true }));
        const environment = { HAPPY_APPLETS_DIRECTORY: root };
        await mkdir(join(root, "demo", "v1"), { recursive: true });
        await writeFile(join(root, "demo", "v1", "index.html"), "<h1>demo</h1>");
        await writeFile(join(root, "secret.txt"), "outside");

        await expect(readAppletFile("demo", 1, "", environment)).resolves.toMatchObject({
            contentType: "text/html; charset=utf-8",
            type: "file",
        });
        await expect(readAppletFile("demo", 1, "../../secret.txt", environment)).resolves.toEqual({
            type: "invalid_path",
        });
        await expect(readAppletFile("demo", 1, "..\\index.html", environment)).resolves.toEqual({
            type: "invalid_path",
        });
        await expect(readAppletFile("demo", 1, "index.html\0", environment)).resolves.toEqual({
            type: "invalid_path",
        });
        await expect(readAppletFile("demo", 1, ".env", environment)).resolves.toEqual({
            type: "invalid_path",
        });
        await expect(readAppletFile("Demo!", 1, "", environment)).resolves.toEqual({
            type: "invalid_path",
        });
        await expect(readAppletFile("demo", 0, "", environment)).resolves.toEqual({
            type: "invalid_path",
        });
        await expect(readAppletFile("demo", 1, "app.exe", environment)).resolves.toEqual({
            type: "not_found",
        });
        await expect(readAppletFile("demo", 2, "", environment)).resolves.toEqual({
            type: "not_found",
        });
    });
});
