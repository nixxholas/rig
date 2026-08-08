import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import type { WorkletManifest } from "../WorkletManifest.js";
import { WorkletInvalidError } from "../WorkletInvalidError.js";
import { WorkletNotFoundError } from "../WorkletNotFoundError.js";
import { WorkletStore } from "../WorkletStore.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("WorkletStore", () => {
    it("imports a source folder into v1 beside the icon and an empty data folder", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const icon = await readFile(join(source, "icon.png"));

        const store = createStore(root);
        const created = await store.install({
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        });

        expect(created).toMatchObject({
            currentVersion: 1,
            description: "Watches a repository",
            name: "github-watch",
            permissions: { disk: "none", network: "none" },
        });
        expect(created.iconThumbhash).not.toBe("");
        await expect(readFile(join(root, "github-watch", "favicon.png"))).resolves.toEqual(icon);
        await expect(readFile(join(root, "github-watch", "favicon.ico"))).resolves.not.toHaveLength(
            0,
        );
        await expect(readFile(join(root, "github-watch", "v1", "index.ts"), "utf8")).resolves.toBe(
            "export const one = 1;\n",
        );
        await expect(readdir(join(root, "github-watch", "Data"))).resolves.toEqual([]);
        expect(store.dataDirectory("github-watch")).toBe(join(root, "github-watch", "Data"));
    });

    it("keeps the data folder across an update, a revert, and an uninstall", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();

        const store = createStore(root);
        await store.install({
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        });
        const durable = join(root, "github-watch", "Data", "state.json");
        await writeFile(durable, '{"seen":7}');

        await writeFile(join(source, "index.ts"), "export const version = 2;\n");
        const updated = await store.update("github-watch", {
            changeDescription: "Follow more repositories",
            path: source,
        });

        expect(updated.currentVersion).toBe(2);
        expect(updated.versions.map((version) => version.version)).toEqual([1, 2]);
        await expect(readFile(join(root, "github-watch", "v2", "index.ts"), "utf8")).resolves.toBe(
            "export const version = 2;\n",
        );
        await expect(readFile(durable, "utf8")).resolves.toBe('{"seen":7}');

        const reverted = store.revert("github-watch", { version: 1 });
        expect(reverted.currentVersion).toBe(1);
        // Reverting moves the pointer; every imported version stays on disk.
        await expect(readFile(join(root, "github-watch", "v2", "index.ts"), "utf8")).resolves.toBe(
            "export const version = 2;\n",
        );
        await expect(readFile(durable, "utf8")).resolves.toBe('{"seen":7}');

        await store.remove("github-watch");
        expect(store.get("github-watch")).toBeUndefined();
        await expect(readdir(join(root, "github-watch"))).resolves.toEqual(["Data"]);
        await expect(readFile(durable, "utf8")).resolves.toBe('{"seen":7}');
    });

    it("refuses a name that is not kebab-case, a second install, and a missing worklet", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);
        const request = {
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        };

        const renamed = await workletSource({ name: "GitHub Watch" });
        await expect(
            store.install({ ...request, iconPath: join(renamed, "icon.png"), path: renamed }),
        ).rejects.toThrow(WorkletInvalidError);
        await store.install(request);
        await expect(store.install(request)).rejects.toThrow(WorkletInvalidError);
        await expect(
            store.update("missing", { changeDescription: "None", path: source }),
        ).rejects.toThrow(WorkletNotFoundError);
        expect(() => store.revert("github-watch", { version: 9 })).toThrow(WorkletInvalidError);
    });

    it("refuses an update whose manifest renames the worklet", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);
        await store.install({
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        });

        const other = await workletSource({ name: "something-else" });

        await expect(
            store.update("github-watch", { changeDescription: "Renamed", path: other }),
        ).rejects.toThrow(WorkletInvalidError);
        expect(store.get("github-watch")?.currentVersion).toBe(1);
    });

    it("records each version's own manifest so reverting restores its permissions", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);
        await store.install({
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        });

        await writeManifest(source, {
            description: "Watches a repository over the network",
            name: "github-watch",
            permissions: { disk: "none", network: { hosts: ["api.github.com"] } },
        });
        const updated = await store.update("github-watch", {
            changeDescription: "Reach GitHub",
            path: source,
        });

        expect(updated.permissions).toEqual({
            disk: "none",
            network: { hosts: ["api.github.com"] },
        });
        expect(updated.description).toBe("Watches a repository over the network");

        const reverted = store.revert("github-watch", { version: 1 });

        expect(reverted.permissions).toEqual({ disk: "none", network: "none" });
        expect(reverted.description).toBe("Watches a repository");
    });

    it("refuses a manifest asking for any disk grant beyond its Data folder", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource({
            permissions: { disk: "full", network: "none" } as never,
        });
        const store = createStore(root);

        await expect(
            store.install({
                authorSessionId: "agent-1",
                iconPath: join(source, "icon.png"),
                path: source,
            }),
        ).rejects.toThrow(WorkletInvalidError);
    });

    it("refuses unrestricted networking so a worklet cannot bind host ports", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource({
            permissions: { disk: "none", network: "full" } as never,
        });
        const store = createStore(root);

        await expect(
            store.install({
                authorSessionId: "agent-1",
                iconPath: join(source, "icon.png"),
                path: source,
            }),
        ).rejects.toThrow(WorkletInvalidError);
    });

    it("refuses staged permissions that differ from the grant reviewed by the caller", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);

        await expect(
            store.install(
                {
                    authorSessionId: "agent-1",
                    iconPath: join(source, "icon.png"),
                    path: source,
                },
                undefined,
                {
                    permissions: {
                        disk: "none",
                        network: { hosts: ["reviewed.example.com"] },
                    },
                },
            ),
        ).rejects.toThrow("do not match the staged source manifest");
        expect(store.get("github-watch")).toBeUndefined();
        await expect(readdir(root)).resolves.not.toContain("github-watch");
    });

    it("replaces an unrecorded version folder left by an interrupted update", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);
        await store.install({
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        });
        const interrupted = join(root, "github-watch", "v2");
        await mkdir(interrupted);
        await writeFile(join(interrupted, "partial.txt"), "not a committed version");

        const updated = await store.update("github-watch", {
            changeDescription: "Second version",
            path: source,
        });

        expect(updated.currentVersion).toBe(2);
        await expect(readFile(join(interrupted, "index.ts"), "utf8")).resolves.toBe(
            "export const one = 1;\n",
        );
        await expect(readFile(join(interrupted, "partial.txt"), "utf8")).rejects.toThrow();
    });

    it("builds a staged update before making it current", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);
        await store.install({
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        });
        await writeFile(
            join(source, "index.ts"),
            'import "./missing-module.js";\nconsole.log("never current");\n',
        );

        await expect(
            store.update("github-watch", {
                changeDescription: "Broken import",
                path: source,
            }),
        ).rejects.toThrow("could not be built");
        expect(store.get("github-watch")).toMatchObject({ currentVersion: 1 });
        expect(store.get("github-watch")?.versions).toHaveLength(1);
    });

    it("refuses a source folder missing either required document, or carrying a placeholder", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const store = createStore(root);
        const install = (source: string) =>
            store.install({
                authorSessionId: "agent-1",
                iconPath: join(source, "icon.png"),
                path: source,
            });

        for (const fileName of ["README.md", "DEVELOPMENT.md"]) {
            const missing = await workletSource();
            await rm(join(missing, fileName));
            await expect(install(missing)).rejects.toThrow(WorkletInvalidError);

            const placeholder = await workletSource();
            await writeFile(join(placeholder, fileName), "# TODO\n");
            await expect(install(placeholder)).rejects.toThrow(WorkletInvalidError);
        }

        // The complete folder still installs, so the refusals above are about the documents.
        await expect(install(await workletSource())).resolves.toMatchObject({
            name: "github-watch",
        });
    });

    it("keeps both documents with the version they were imported with", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);

        await store.install({
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        });

        await expect(readdir(join(root, "github-watch", "v1"))).resolves.toEqual(
            expect.arrayContaining(["DEVELOPMENT.md", "README.md", "worklet.json"]),
        );
    });

    it("refuses a source folder with no manifest at its root", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        await rm(join(source, "worklet.json"));
        const store = createStore(root);

        await expect(
            store.install({
                authorSessionId: "agent-1",
                iconPath: join(source, "icon.png"),
                path: source,
            }),
        ).rejects.toThrow(WorkletInvalidError);
    });

    it("refuses a source folder containing a symlink", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const outside = await temporaryDirectory("rig-worklet-outside-");
        await writeFile(join(outside, "secret.txt"), "secret");
        await mkdir(join(source, "nested"));
        await symlink(join(outside, "secret.txt"), join(source, "nested", "leak.txt"));

        const store = createStore(root);
        await expect(
            store.install({
                authorSessionId: "agent-1",
                iconPath: join(source, "icon.png"),
                path: source,
            }),
        ).rejects.toThrow(WorkletInvalidError);
        await expect(readdir(root)).resolves.not.toContain("github-watch/v1");
    });

    it("reinstalling after an uninstall keeps the earlier data and starts versions over", async () => {
        const root = await temporaryDirectory("rig-worklet-store-");
        const source = await workletSource();
        const store = createStore(root);
        const request = {
            authorSessionId: "agent-1",
            iconPath: join(source, "icon.png"),
            path: source,
        };
        await store.install(request);
        await store.update("github-watch", { changeDescription: "Second", path: source });
        await writeFile(join(root, "github-watch", "Data", "state.json"), '{"seen":7}');
        await store.remove("github-watch");

        const reinstalled = await store.install(request);

        expect(reinstalled.currentVersion).toBe(1);
        await expect(
            readFile(join(root, "github-watch", "Data", "state.json"), "utf8"),
        ).resolves.toBe('{"seen":7}');
        await expect(readdir(join(root, "github-watch"))).resolves.toEqual(
            expect.not.arrayContaining(["v2"]),
        );
    });
});

function createStore(root: string, databasePath = ":memory:"): WorkletStore {
    const opened = openSessionDatabase(databasePath);
    migrateSessionDatabase(opened.database);
    cleanups.push(() => {
        opened.client.close();
    });
    return new WorkletStore({
        environment: { HAPPY_WORKLETS_DIRECTORY: root },
        tx: () => opened.database,
    });
}

/** A complete importable worklet folder: a manifest, an entry point, and an icon. */
async function workletSource(manifest: Partial<WorkletManifest> = {}): Promise<string> {
    const source = await temporaryDirectory("rig-worklet-source-");
    await writeManifest(source, {
        description: "Watches a repository",
        name: "github-watch",
        permissions: { disk: "none", network: "none" },
        ...manifest,
    });
    await writeFile(join(source, "index.ts"), "export const one = 1;\n");
    await writeFile(join(source, "icon.png"), await iconPng());
    await writeWorkletDocuments(source);
    return source;
}

async function writeManifest(source: string, manifest: WorkletManifest): Promise<void> {
    await writeFile(join(source, "worklet.json"), JSON.stringify(manifest, null, 4));
}

/** Every worklet folder carries both documents, so every fixture folder does too. */
async function writeWorkletDocuments(source: string): Promise<void> {
    await writeFile(
        join(source, "README.md"),
        "# github-watch\n\nWatches a repository and tells you when something lands.\n",
    );
    await writeFile(
        join(source, "DEVELOPMENT.md"),
        "# Development\n\nPolls the API on a timer and keeps the last seen commit in Data.\n",
    );
}

async function iconPng(): Promise<Buffer> {
    return sharp({
        create: {
            background: { alpha: 1, b: 50, g: 100, r: 200 },
            channels: 4,
            height: 512,
            width: 512,
        },
    })
        .png()
        .toBuffer();
}

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return directory;
}
