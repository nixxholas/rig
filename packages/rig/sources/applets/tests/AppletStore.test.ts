import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { AppletInvalidError } from "../AppletInvalidError.js";
import { AppletStore } from "../AppletStore.js";
import { isDatabaseFailure } from "../../persistence/isDatabaseFailure.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("AppletStore", () => {
    it("atomically imports safe source files, preserving its 512px icon and persisted metadata", async () => {
        const root = await temporaryDirectory("rig-applet-store-");
        const source = await temporaryDirectory("rig-applet-source-");
        const icon = await iconPng();
        await writeFile(join(source, "index.html"), "<h1>one</h1>");
        await writeFile(join(source, "icon.png"), icon);

        const store = await createStore(root);
        const created = await store.applets.create(store.ctx, {
            authorSessionId: "agent-1",
            description: "A dashboard",
            iconPath: join(source, "icon.png"),
            name: "dashboard",
            path: source,
            purpose: "Track work",
        });

        expect(created).toMatchObject({
            iconUrl: "/applets/dashboard/favicon.png",
            name: "dashboard",
        });
        expect(created.iconThumbhash).not.toBe("");
        await expect(readFile(join(root, "dashboard", "favicon.png"))).resolves.toEqual(icon);
        await expect(readFile(join(root, "dashboard", "favicon.ico"))).resolves.not.toHaveLength(0);
        await expect(readFile(join(root, "dashboard", "v1", "index.html"), "utf8")).resolves.toBe(
            "<h1>one</h1>",
        );
        await expect(store.applets.readIcon(store.ctx, "dashboard", "png")).resolves.toMatchObject({
            contentType: "image/png",
            data: icon,
            type: "file",
        });
    });

    it("persists declared scopes and replaces them when a new version declares new scopes", async () => {
        const data = await temporaryDirectory("rig-applet-store-");
        const source = await temporaryDirectory("rig-applet-source-");
        await writeFile(join(source, "index.html"), "<h1>one</h1>");
        await writeFile(join(source, "icon.png"), await iconPng());
        const databasePath = join(data, "sessions.db");

        const first = await createStore(data, databasePath);
        await expect(
            first.applets.create(first.ctx, {
                allowedScopes: ["session", "workspace"],
                authorSessionId: "agent-1",
                description: "A dashboard",
                iconPath: join(source, "icon.png"),
                name: "dashboard",
                path: source,
                purpose: "Track work",
            }),
        ).resolves.toMatchObject({ allowedScopes: ["session", "workspace"] });
        await first.applets.update(first.ctx, "dashboard", {
            allowedScopes: ["project"],
            changeDescription: "Project-only lifetime",
            path: source,
        });
        const restored = await createStore(data, databasePath);
        expect(await restored.applets.get(restored.ctx, "dashboard")).toMatchObject({
            allowedScopes: ["project"],
            currentVersion: 2,
        });
    });

    it("rejects symbolic links in the imported source tree before recording a version", async () => {
        const root = await temporaryDirectory("rig-applet-store-");
        const source = await temporaryDirectory("rig-applet-source-");
        const icon = await iconPng();
        await writeFile(join(source, "icon.png"), icon);
        await writeFile(join(source, "outside.txt"), "outside");
        await symlink(join(source, "outside.txt"), join(source, "linked.txt"));

        const store = await createStore(root);
        await expect(
            store.applets.create(store.ctx, {
                authorSessionId: "agent-1",
                description: "A dashboard",
                iconPath: join(source, "icon.png"),
                name: "dashboard",
                path: source,
                purpose: "Track work",
            }),
        ).rejects.toBeInstanceOf(AppletInvalidError);
        expect(await store.applets.get(store.ctx, "dashboard")).toBeUndefined();
    });

    it("rejects a symbolic link used as the required icon", async () => {
        const root = await temporaryDirectory("rig-applet-store-");
        const source = await temporaryDirectory("rig-applet-source-");
        const icon = await iconPng();
        const iconTarget = join(source, "icon-target.png");
        const iconLink = join(source, "icon.png");
        await writeFile(join(source, "index.html"), "<h1>one</h1>");
        await writeFile(iconTarget, icon);
        await symlink(iconTarget, iconLink);

        const store = await createStore(root);
        await expect(
            store.applets.create(store.ctx, {
                authorSessionId: "agent-1",
                description: "A dashboard",
                iconPath: iconLink,
                name: "dashboard",
                path: source,
                purpose: "Track work",
            }),
        ).rejects.toBeInstanceOf(AppletInvalidError);
        expect(await store.applets.get(store.ctx, "dashboard")).toBeUndefined();
    });

    it("reclaims a stranded pre-icon data directory without deleting it", async () => {
        const root = await temporaryDirectory("rig-applet-store-");
        const source = await temporaryDirectory("rig-applet-source-");
        const icon = await iconPng();
        await mkdir(join(root, "dashboard"));
        await writeFile(join(root, "dashboard", "legacy.txt"), "legacy");
        await writeFile(join(source, "index.html"), "<h1>new</h1>");
        await writeFile(join(source, "icon.png"), icon);

        const store = await createStore(root);
        await expect(
            store.applets.create(store.ctx, {
                authorSessionId: "agent-1",
                description: "A dashboard",
                iconPath: join(source, "icon.png"),
                name: "dashboard",
                path: source,
                purpose: "Track work",
            }),
        ).resolves.toMatchObject({ name: "dashboard" });
        await expect(readFile(join(root, "dashboard", "v1", "index.html"), "utf8")).resolves.toBe(
            "<h1>new</h1>",
        );
        const orphan = (await readdir(root)).find((entry) =>
            entry.startsWith(".dashboard-orphan-"),
        );
        expect(orphan).toBeDefined();
        await expect(readFile(join(root, orphan!, "legacy.txt"), "utf8")).resolves.toBe("legacy");
    });

    it("serializes concurrent creates for the same name", async () => {
        const root = await temporaryDirectory("rig-applet-store-");
        const source = await temporaryDirectory("rig-applet-source-");
        const icon = await iconPng();
        await writeFile(join(source, "index.html"), "<h1>one</h1>");
        await writeFile(join(source, "icon.png"), icon);
        const store = await createStore(root);
        const request = {
            authorSessionId: "agent-1",
            description: "A dashboard",
            iconPath: join(source, "icon.png"),
            name: "dashboard",
            path: source,
            purpose: "Track work",
        };

        const results = await Promise.allSettled([
            store.applets.create(store.ctx, request),
            store.applets.create(store.ctx, request),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        await expect(readFile(join(root, "dashboard", "v1", "index.html"), "utf8")).resolves.toBe(
            "<h1>one</h1>",
        );
        expect((await readdir(root)).filter((entry) => entry.includes("-orphan-"))).toEqual([]);
    });

    it("restores a stranded directory when database creation fails", async () => {
        const root = await temporaryDirectory("rig-applet-store-");
        const source = await temporaryDirectory("rig-applet-source-");
        const icon = await iconPng();
        await mkdir(join(root, "dashboard"));
        await writeFile(join(root, "dashboard", "legacy.txt"), "legacy");
        await writeFile(join(source, "index.html"), "<h1>new</h1>");
        await writeFile(join(source, "icon.png"), icon);
        const store = await createStore(root);
        await store.client.execute(`
            CREATE TRIGGER reject_applet_create
            BEFORE INSERT ON applets
            BEGIN
                SELECT RAISE(ABORT, 'rejected applet');
            END
        `);

        const failure = await store.applets
            .create(store.ctx, {
                authorSessionId: "agent-1",
                description: "A dashboard",
                iconPath: join(source, "icon.png"),
                name: "dashboard",
                path: source,
                purpose: "Track work",
            })
            .then(
                () => undefined,
                (error: unknown) => error,
            );
        expect(isDatabaseFailure(failure)).toBe(true);
        await expect(readFile(join(root, "dashboard", "legacy.txt"), "utf8")).resolves.toBe(
            "legacy",
        );
        expect((await readdir(root)).filter((entry) => entry.includes("-orphan-"))).toEqual([]);
    });
});

async function createStore(
    root: string,
    databasePath = ":memory:",
): Promise<{
    ctx: Awaited<ReturnType<typeof openSessionDatabase>>["ctx"];
    database: Awaited<ReturnType<typeof openSessionDatabase>>["database"];
    client: Awaited<ReturnType<typeof openSessionDatabase>>["client"];
    applets: AppletStore;
}> {
    const rootCtx = createTestRootContext();
    const opened = await openSessionDatabase(rootCtx, databasePath);
    await migrateSessionDatabase(opened.ctx);
    const store = new AppletStore({
        database: opened.database,
        environment: { HAPPY_APPLETS_DIRECTORY: root },
        publish: () => {},
    });
    cleanups.push(() => {
        return opened.database.close(opened.ctx);
    });
    return { ctx: rootCtx, client: opened.client, database: opened.database, applets: store };
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
