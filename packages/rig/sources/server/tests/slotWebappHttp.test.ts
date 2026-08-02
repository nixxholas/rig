import { request as requestHttp } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const servers: ReturnType<typeof createProtocolHttpServer>[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
const originalWebappsDirectory = process.env.HAPPY_WEBAPPS_DIRECTORY;

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                    server.closeAllConnections();
                }),
        ),
    );
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    if (originalWebappsDirectory === undefined) delete process.env.HAPPY_WEBAPPS_DIRECTORY;
    else process.env.HAPPY_WEBAPPS_DIRECTORY = originalWebappsDirectory;
});

describe("slot HTTP protocol", () => {
    it("surfaces an incompatible slot scope as a typed invalid-entry error", async () => {
        const port = await startServer();

        const response = await request(port, {
            body: JSON.stringify({
                author: { type: "agent", sessionId: "session-1" },
                content: { markdown: "Session shortcut", type: "text" },
                description: "Session shortcut",
                purpose: "Keep this session visible",
                scope: "session",
                sessionId: "session-1",
                slot: "sidebar",
            }),
            method: "POST",
            path: "/slots",
        });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({
            error: {
                code: "invalid_entry",
                message: "The sidebar slot allows only the everywhere scope.",
            },
        });
    });

    it("creates, lists, updates, and removes entries with typed rejections", async () => {
        const port = await startServer();

        const created = await request(port, {
            body: JSON.stringify({
                author: { type: "agent", sessionId: "session-1" },
                content: { markdown: "**All green**", type: "text" },
                description: "Status text",
                purpose: "Keeps CI visible",
                scope: "everywhere",
                slot: "status-line",
            }),
            method: "POST",
            path: "/slots",
        });
        expect(created.status).toBe(201);
        const entry = (JSON.parse(created.body) as { entry: { id: string } }).entry;

        const unknownSlot = await request(port, {
            body: JSON.stringify({
                author: { type: "agent", sessionId: "session-1" },
                content: { markdown: "x", type: "text" },
                description: "d",
                purpose: "p",
                scope: "everywhere",
                slot: "footer",
            }),
            method: "POST",
            path: "/slots",
        });
        expect(unknownSlot.status).toBe(400);
        expect(JSON.parse(unknownSlot.body)).toMatchObject({
            error: { code: "invalid_entry" },
        });

        const malformedAction = await request(port, {
            body: JSON.stringify({
                author: { type: "agent", sessionId: "session-1" },
                content: {
                    action: { type: "send-chat", message: "hello" },
                    label: "Send",
                    type: "button",
                },
                description: "d",
                purpose: "p",
                scope: "everywhere",
                slot: "sidebar",
            }),
            method: "POST",
            path: "/slots",
        });
        expect(malformedAction.status).toBe(400);
        expect(JSON.parse(malformedAction.body)).toMatchObject({
            error: { code: "invalid_entry" },
        });

        const webappButton = await request(port, {
            body: JSON.stringify({
                author: { type: "agent", sessionId: "session-1" },
                content: {
                    action: {
                        path: "/reports/daily",
                        query: { range: "7d", team: "platform" },
                        type: "open-webapp",
                        webapp: "usage-dashboard",
                    },
                    label: "Open usage",
                    type: "button",
                },
                description: "Usage shortcut",
                purpose: "Open the requested report",
                scope: "everywhere",
                slot: "sidebar",
            }),
            method: "POST",
            path: "/slots",
        });
        expect(webappButton.status).toBe(201);
        expect(JSON.parse(webappButton.body)).toMatchObject({
            entry: {
                content: {
                    action: {
                        path: "/reports/daily",
                        query: { range: "7d", team: "platform" },
                        type: "open-webapp",
                        webapp: "usage-dashboard",
                    },
                },
            },
        });

        const listed = await request(port, { path: "/slots?slot=status-line" });
        expect(listed.status).toBe(200);
        expect(JSON.parse(listed.body)).toMatchObject({
            entries: [{ id: entry.id, slot: "status-line" }],
        });

        const updated = await request(port, {
            body: JSON.stringify({ description: "Renamed status text" }),
            method: "PATCH",
            path: `/slots/${entry.id}`,
        });
        expect(updated.status).toBe(200);
        expect(JSON.parse(updated.body)).toMatchObject({
            entry: { description: "Renamed status text" },
        });

        const removed = await request(port, { method: "DELETE", path: `/slots/${entry.id}` });
        expect(removed.status).toBe(200);
        const missing = await request(port, { method: "DELETE", path: `/slots/${entry.id}` });
        expect(missing.status).toBe(404);
        expect(JSON.parse(missing.body)).toMatchObject({ error: { code: "entry_not_found" } });
    });

    it("requires the bearer token", async () => {
        const port = await startServer();
        const denied = await request(port, { path: "/slots", token: "wrong" });
        expect(denied.status).toBe(401);
        const unknown = await request(port, { path: "/unknown-route", token: "wrong" });
        expect(unknown.status).toBe(401);
    });
});

describe("webapp HTTP protocol", () => {
    it("imports versions, serves only the current version safely, and reverts", async () => {
        const port = await startServer();
        const sources = await createTempDirectory("rig-webapp-sources-");
        const sourceV1 = join(sources, "v1-src");
        await mkdir(join(sourceV1, "assets"), { recursive: true });
        await writeFile(join(sourceV1, "index.html"), "<h1>one</h1>");
        await writeFile(join(sourceV1, "assets", "app.js"), "console.log(1);");
        await writeFile(join(sourceV1, ".env"), "SECRET=1");
        await writeFile(join(sources, "outside.txt"), "outside");
        await symlink(join(sources, "outside.txt"), join(sourceV1, "escape.txt"));
        const iconPath = join(sources, "icon.png");
        const iconBytes = await createIcon(iconPath, 512);

        const badName = await request(port, {
            body: JSON.stringify({
                authorSessionId: "session-1",
                description: "d",
                iconPath,
                name: "Not Kebab",
                path: sourceV1,
                purpose: "p",
            }),
            method: "POST",
            path: "/webapps",
        });
        expect(badName.status).toBe(400);
        expect(JSON.parse(badName.body)).toMatchObject({ error: { code: "invalid_webapp" } });

        const invalidIconPath = join(sources, "small-icon.png");
        await createIcon(invalidIconPath, 256);
        const invalidIcon = await request(port, {
            body: JSON.stringify({
                authorSessionId: "session-1",
                description: "Usage dashboard",
                iconPath: invalidIconPath,
                name: "usage-dashboard",
                path: sourceV1,
                purpose: "Track spend",
            }),
            method: "POST",
            path: "/webapps",
        });
        expect(invalidIcon.status).toBe(400);
        expect(JSON.parse(invalidIcon.body)).toMatchObject({
            error: { code: "invalid_webapp" },
        });

        const symlinkedSource = await request(port, {
            body: JSON.stringify({
                authorSessionId: "session-1",
                description: "Symlinked dashboard",
                iconPath,
                name: "symlinked-dashboard",
                path: sourceV1,
                purpose: "Verify safe imports",
            }),
            method: "POST",
            path: "/webapps",
        });
        expect(symlinkedSource.status).toBe(400);
        expect(JSON.parse(symlinkedSource.body)).toMatchObject({
            error: { code: "invalid_webapp" },
        });
        await rm(join(sourceV1, "escape.txt"));

        const created = await request(port, {
            body: JSON.stringify({
                authorSessionId: "session-1",
                description: "Usage dashboard",
                iconPath,
                name: "usage-dashboard",
                path: sourceV1,
                purpose: "Track spend",
                sourceDescription: "The demo project, dashboard folder",
            }),
            method: "POST",
            path: "/webapps",
        });
        expect(created.status).toBe(201);
        expect(JSON.parse(created.body)).toMatchObject({
            webapp: {
                allowedScopes: ["everywhere", "project", "workspace", "session"],
                currentVersion: 1,
                iconThumbhash: expect.any(String),
                iconUrl: "/webapps/usage-dashboard/favicon.png",
                name: "usage-dashboard",
                versions: [{ changeDescription: "Initial import", version: 1 }],
            },
        });

        const opened = await request(port, {
            body: JSON.stringify({
                path: "reports/daily.html",
                query: { range: "7d" },
                sessionId: "session-1",
            }),
            method: "POST",
            path: "/webapps/usage-dashboard/open",
        });
        expect(opened.status).toBe(200);
        const openUrl = new URL(
            (JSON.parse(opened.body) as { url: string }).url,
            "http://rig.test",
        );
        expect(openUrl.pathname).toBe("/webapps/usage-dashboard/files/reports/daily.html");
        expect(openUrl.searchParams.get("range")).toBe("7d");
        const contextToken = openUrl.searchParams.get("rigContext");
        expect(contextToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u);

        const unauthorizedContext = await request(port, {
            path: "/webapps/usage-dashboard/context?token=wrong",
            token: "wrong",
        });
        expect(unauthorizedContext.status).toBe(401);
        const context = await request(port, {
            path: `/webapps/usage-dashboard/context?token=${encodeURIComponent(contextToken!)}`,
            token: "wrong",
        });
        expect(context.status).toBe(200);
        expect(context.headers["cache-control"]).toBe("no-store");
        expect(JSON.parse(context.body)).toEqual({
            projectId: expect.any(String),
            sessionId: "session-1",
            version: 1,
            webapp: "usage-dashboard",
        });
        const reused = await request(port, {
            path: `/webapps/usage-dashboard/context?token=${encodeURIComponent(contextToken!)}`,
            token: "wrong",
        });
        expect(reused.status).toBe(401);

        const favicon = await request(port, {
            path: "/webapps/usage-dashboard/favicon.png",
        });
        expect(favicon.status).toBe(200);
        expect(favicon.headers["content-type"]).toBe("image/png");
        expect(favicon.raw).toEqual(iconBytes);

        const ico = await request(port, {
            path: "/webapps/usage-dashboard/favicon.ico",
        });
        expect(ico.status).toBe(200);
        expect(ico.headers["content-type"]).toBe("image/x-icon");
        expect(ico.raw.subarray(0, 6)).toEqual(Buffer.from([0, 0, 1, 0, 6, 0]));

        const index = await request(port, { path: "/webapps/usage-dashboard/files/" });
        expect(index.status).toBe(200);
        expect(index.body).toBe("<h1>one</h1>");
        expect(index.headers["x-content-type-options"]).toBe("nosniff");
        expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");

        const nested = await request(port, {
            path: "/webapps/usage-dashboard/files/assets/app.js",
        });
        expect(nested.status).toBe(200);

        const dotfile = await request(port, { path: "/webapps/usage-dashboard/files/.env" });
        expect(dotfile.status).toBe(400);
        // The WHATWG URL parser collapses encoded dot segments before routing, so an encoded
        // traversal lands back inside the webapp instead of ever reaching the filesystem above it.
        const traversal = await request(port, {
            path: "/webapps/usage-dashboard/files/assets/%2e%2e/index.html",
        });
        expect(traversal.body).toBe("<h1>one</h1>");
        await symlink(
            join(sources, "outside.txt"),
            join(process.env.HAPPY_WEBAPPS_DIRECTORY!, "usage-dashboard", "v1", "escape.txt"),
        );
        const symlinked = await request(port, {
            path: "/webapps/usage-dashboard/files/escape.txt",
        });
        expect(symlinked.status).toBe(400);
        const unknownExtension = await request(port, {
            path: "/webapps/usage-dashboard/files/index.exe",
        });
        expect(unknownExtension.status).toBe(404);
        const unknownWebapp = await request(port, { path: "/webapps/other/files/" });
        expect(unknownWebapp.status).toBe(404);

        const sourceV2 = join(sources, "v2-src");
        await mkdir(sourceV2, { recursive: true });
        await writeFile(join(sourceV2, "index.html"), "<h1>two</h1>");

        const missingChange = await request(port, {
            body: JSON.stringify({ path: sourceV2 }),
            method: "POST",
            path: "/webapps/usage-dashboard/versions",
        });
        expect(missingChange.status).toBe(400);

        const updated = await request(port, {
            body: JSON.stringify({ changeDescription: "New headline", path: sourceV2 }),
            method: "POST",
            path: "/webapps/usage-dashboard/versions",
        });
        expect(updated.status).toBe(200);
        expect(JSON.parse(updated.body)).toMatchObject({ webapp: { currentVersion: 2 } });
        const second = await request(port, { path: "/webapps/usage-dashboard/files/" });
        expect(second.body).toBe("<h1>two</h1>");

        const badRevert = await request(port, {
            body: JSON.stringify({ version: 9 }),
            method: "POST",
            path: "/webapps/usage-dashboard/revert",
        });
        expect(badRevert.status).toBe(400);
        const reverted = await request(port, {
            body: JSON.stringify({ version: 1 }),
            method: "POST",
            path: "/webapps/usage-dashboard/revert",
        });
        expect(reverted.status).toBe(200);
        expect(JSON.parse(reverted.body)).toMatchObject({
            webapp: { currentVersion: 1, versions: [{ version: 1 }, { version: 2 }] },
        });
        const first = await request(port, { path: "/webapps/usage-dashboard/files/" });
        expect(first.body).toBe("<h1>one</h1>");

        const listed = await request(port, { path: "/webapps" });
        expect(listed.status).toBe(200);
        expect(JSON.parse(listed.body)).toMatchObject({
            webapps: [{ currentVersion: 1, name: "usage-dashboard" }],
        });
    });

    it("rejects opening a webapp after its declaration narrows past an existing slot", async () => {
        const port = await startServer();
        const sources = await createTempDirectory("rig-webapp-scopes-");
        const sourceV1 = join(sources, "v1");
        const sourceV2 = join(sources, "v2");
        await mkdir(sourceV1);
        await mkdir(sourceV2);
        await writeFile(join(sourceV1, "index.html"), "<h1>one</h1>");
        await writeFile(join(sourceV2, "index.html"), "<h1>two</h1>");
        const iconPath = join(sources, "icon.png");
        await createIcon(iconPath, 512);

        const slot = await request(port, {
            body: JSON.stringify({
                author: { type: "agent", sessionId: "session-1" },
                content: {
                    action: { type: "open-webapp", webapp: "scoped-dashboard" },
                    label: "Open dashboard",
                    type: "button",
                },
                description: "Dashboard",
                purpose: "Track work",
                scope: "everywhere",
                slot: "status-line",
            }),
            method: "POST",
            path: "/slots",
        });
        expect(slot.status).toBe(201);

        const created = await request(port, {
            body: JSON.stringify({
                allowedScopes: ["everywhere"],
                authorSessionId: "session-1",
                description: "Scoped dashboard",
                iconPath,
                name: "scoped-dashboard",
                path: sourceV1,
                purpose: "Track work",
            }),
            method: "POST",
            path: "/webapps",
        });
        expect(created.status).toBe(201);

        const narrowed = await request(port, {
            body: JSON.stringify({
                allowedScopes: ["project"],
                changeDescription: "Use project lifetime",
                path: sourceV2,
            }),
            method: "POST",
            path: "/webapps/scoped-dashboard/versions",
        });
        expect(narrowed.status).toBe(200);

        const opened = await request(port, {
            body: JSON.stringify({}),
            method: "POST",
            path: "/webapps/scoped-dashboard/open",
        });
        expect(opened.status).toBe(400);
        expect(JSON.parse(opened.body)).toEqual({
            error: {
                code: "invalid_webapp",
                message:
                    'The webapp "scoped-dashboard" does not allow the everywhere scope. It allows only the project scope.',
            },
        });
    });
});

async function startServer(): Promise<number> {
    process.env.HAPPY_WEBAPPS_DIRECTORY = await createTempDirectory("rig-webapps-test-");
    const store = new InMemorySessionStore();
    store.createWithId("session-1", { cwd: "/tmp/rig-webapp-context-test" });
    cleanups.push(() => store.close());
    const server = createProtocolHttpServer({ store, token: "secret" });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port.");
    return address.port;
}

async function createTempDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(() => rm(directory, { force: true, recursive: true }));
    return directory;
}

async function createIcon(path: string, size: number): Promise<Buffer> {
    const bytes = await sharp({
        create: {
            background: { alpha: 1, b: 180, g: 100, r: 40 },
            channels: 4,
            height: size,
            width: size,
        },
    })
        .png()
        .toBuffer();
    await writeFile(path, bytes);
    return bytes;
}

function request(
    port: number,
    options: { body?: string; method?: string; path: string; token?: string },
): Promise<{
    body: string;
    headers: Record<string, string | string[] | undefined>;
    raw: Buffer;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const httpRequest = requestHttp(
            {
                headers: {
                    authorization: `Bearer ${options.token ?? "secret"}`,
                    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
                },
                host: "127.0.0.1",
                method: options.method ?? "GET",
                path: options.path,
                port,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        raw: Buffer.concat(chunks),
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        httpRequest.on("error", reject);
        httpRequest.end(options.body);
    });
}
