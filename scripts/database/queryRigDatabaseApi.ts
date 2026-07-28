import { once } from "node:events";
import type { Server } from "node:http";

import type {
    GlobalStreamHello,
    HealthResponse,
} from "../../packages/rig/sources/protocol/index.js";
import { createUnixSocketFetch } from "../../packages/rig/sources/client/createUnixSocketFetch.js";
import type { PersistentSessionStore } from "../../packages/rig/sources/server/PersistentSessionStore.js";
import { createProtocolHttpServer } from "../../packages/rig/sources/server/createProtocolHttpServer.js";

import type { RigDatabaseCatalog } from "./inspectRigDatabase.js";

export interface RigDatabaseApiInspection {
    checkedSessions: number;
    projects: number;
    sessions: number;
    workspaces: number;
}

export async function queryRigDatabaseApi(options: {
    catalog: RigDatabaseCatalog;
    socketPath: string;
    store: PersistentSessionStore;
    token: string;
}): Promise<RigDatabaseApiInspection> {
    const server = createProtocolHttpServer({
        store: options.store,
        token: options.token,
    });
    await listen(server, options.socketPath);
    const request = createUnixSocketFetch(options.socketPath);
    try {
        const health = await requestJson<HealthResponse>(request, options.token, "/health");
        if (health.healthy !== true || health.status !== "ready") {
            throw new Error("The copied database API did not report ready.");
        }

        const hello = await readGlobalHello(request, options.token);
        if (!hello.sessionsComplete) {
            throw new Error("The global API snapshot reported an incomplete session catalog.");
        }
        assertSameIds(
            "active projects",
            options.catalog.activeProjectIds,
            hello.projects.map((project) => project.id),
        );
        assertSameIds(
            "active workspaces",
            options.catalog.activeWorkspaceIds,
            hello.workspaces.map((workspace) => workspace.id),
        );
        assertSameIds(
            "active root sessions",
            options.catalog.activeRootSessionIds,
            hello.sessions.map((session) => session.id),
        );

        const projects = await requestJson<{ projects: readonly { id: string }[] }>(
            request,
            options.token,
            "/projects",
        );
        assertSameIds(
            "all projects",
            options.catalog.projectIds,
            projects.projects.map((project) => project.id),
        );

        const sampleIds = sample(options.catalog.activeRootSessionIds, 3);
        for (const sessionId of sampleIds) {
            const response = await requestJson<{ session: { id: string } }>(
                request,
                options.token,
                `/sessions/${encodeURIComponent(sessionId)}?message_limit=1`,
            );
            if (response.session.id !== sessionId) {
                throw new Error("The session API returned a different session.");
            }
        }

        return {
            checkedSessions: sampleIds.length,
            projects: hello.projects.length,
            sessions: hello.sessions.length,
            workspaces: hello.workspaces.length,
        };
    } finally {
        await closeServer(server);
    }
}

async function readGlobalHello(
    request: typeof globalThis.fetch,
    token: string,
): Promise<GlobalStreamHello> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    timeout.unref?.();
    try {
        const response = await request("http://rig.local/events/stream", {
            headers: {
                accept: "text/event-stream",
                authorization: `Bearer ${token}`,
            },
            signal: controller.signal,
        });
        if (!response.ok || response.body === null) {
            throw new Error(`The global stream returned HTTP ${String(response.status)}.`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const item = await reader.read();
            if (item.done) throw new Error("The global stream ended before its opening frame.");
            buffer += decoder.decode(item.value, { stream: true });
            for (;;) {
                const boundary = buffer.indexOf("\n\n");
                if (boundary < 0) break;
                const frame = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                if (frame.startsWith(":")) continue;
                const eventName = frame
                    .split("\n")
                    .find((line) => line.startsWith("event:"))
                    ?.slice("event:".length)
                    .trim();
                if (eventName !== "hello") {
                    throw new Error("The global stream did not begin with its opening frame.");
                }
                const data = frame
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice("data:".length).trimStart())
                    .join("\n");
                return JSON.parse(data) as GlobalStreamHello;
            }
        }
    } finally {
        clearTimeout(timeout);
        controller.abort();
    }
}

async function requestJson<T>(
    request: typeof globalThis.fetch,
    token: string,
    path: string,
): Promise<T> {
    const response = await request(`http://rig.local${path}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(
            `${path} returned HTTP ${String(response.status)}: ${await response.text()}`,
        );
    }
    return (await response.json()) as T;
}

function assertSameIds(
    label: string,
    expected: readonly string[],
    actual: readonly string[],
): void {
    const sortedActual = [...actual].sort();
    if (
        expected.length !== sortedActual.length ||
        expected.some((id, index) => id !== sortedActual[index])
    ) {
        throw new Error(
            `The API returned ${String(actual.length)} ${label}; SQL returned ${String(expected.length)}.`,
        );
    }
}

function sample(values: readonly string[], limit: number): readonly string[] {
    if (values.length <= limit) return values;
    return [values[0]!, values[Math.floor(values.length / 2)]!, values[values.length - 1]!];
}

async function listen(server: Server, socketPath: string): Promise<void> {
    server.listen(socketPath);
    await once(server, "listening");
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    server.close();
    await once(server, "close");
}
