import { describe, expect, it } from "vitest";

import { connectRig } from "@/connectRig.js";
import type { GlobalStreamHello, SessionSummary } from "@/protocol.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((onResolve) => (resolve = onResolve));
    return { promise, resolve };
}

async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const randomValues = (bytes: Uint8Array): Uint8Array => {
    bytes.fill(1);
    return bytes;
};

function streamResponse() {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(next) {
            controller = next;
        },
    });
    return {
        close: () => controller.close(),
        response: new Response(body, { status: 200 }),
        write: (frame: string) => controller.enqueue(encoder.encode(frame)),
    };
}

const OLD_VERSION = "01900000-0000-7000-8000-000000000001";
const NEW_VERSION = "01900000-0000-7000-8000-000000000009";

function session(lastEventId: string, title: string): SessionSummary {
    return {
        activity: { kind: "idle", label: "Idle", since: 1 },
        archived: false,
        createdAt: 1,
        cwd: "/work",
        id: "session-1",
        lastEventId,
        modelId: "model",
        modelLocked: false,
        models: [],
        orderKey: "a",
        pendingUserInputs: [],
        permissionMode: "auto",
        projectId: "project-1",
        status: "idle",
        title,
        updatedAt: 1,
    } as unknown as SessionSummary;
}

function catalog(sessions: readonly SessionSummary[], cursor = OLD_VERSION): GlobalStreamHello {
    return {
        cursor,
        protocolVersion: 1,
        projects: [
            {
                createdAt: 1,
                id: "project-1",
                initializationStatus: "ready",
                kind: "regular",
                name: "Project",
                nameSource: "folder",
                orderKey: "a",
                path: "/work",
                presence: "present",
                updatedAt: 1,
                version: 3,
                worktreeSupport: "supported",
            },
        ],
        sessions,
        sessionsComplete: true,
        terminalGroups: [],
        workspaces: [],
    } as unknown as GlobalStreamHello;
}

function liveHello(cursor: string, gap: boolean, resumed: boolean): string {
    return `event: hello\ndata: ${JSON.stringify({ cursor, gap, protocolVersion: 1, resumed })}\n\n`;
}

function titleEvent(title: string): string {
    const update = {
        cursor: NEW_VERSION,
        event: {
            createdAt: 2,
            data: { title },
            id: NEW_VERSION,
            sessionId: "session-1",
            type: "session_title_changed",
        },
    };
    return `event: update\ndata: ${JSON.stringify(update)}\n\n`;
}

describe("reconnecting while the catalog is in flight", () => {
    it("does not let a stale catalog on reconnect overwrite a newer streamed session", async () => {
        const stream = streamResponse();
        const first = deferred<void>();
        const held = deferred<void>();
        let catalogRequests = 0;

        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return stream.response;
                if (url.pathname === "/catalog") {
                    catalogRequests += 1;
                    // The first load answers promptly; the reload is held so the
                    // stream delivers a newer fact before it lands. That the fetch
                    // is async is ordinary, not contrived.
                    await (catalogRequests === 1 ? first.promise : held.promise);
                    return new Response(JSON.stringify(catalog([session(OLD_VERSION, "Before")])), {
                        status: 200,
                    });
                }
                throw new Error(`Unexpected request to ${url.pathname}`);
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });

        try {
            // The first load settles, so the client knows this session.
            stream.write(liveHello(OLD_VERSION, false, false));
            await settle();
            first.resolve();
            await settle();
            expect(catalogRequests).toBe(1);

            // A drop with a gap forces a reload. The reload is snapshotted at the
            // old position and held, so a newer fact overtakes it in flight.
            stream.write(liveHello(OLD_VERSION, true, false));
            await settle();
            expect(catalogRequests).toBe(2);

            stream.write(titleEvent("After"));
            await settle();

            held.resolve();
            await settle();

            const listed = connection
                .projects()
                .flatMap((project) => project.sessions ?? [])
                .find((entry) => entry.id === "session-1");
            expect(listed?.title).toBe("After");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("replays an event that arrived before the session it describes was loaded", async () => {
        const stream = streamResponse();
        const held = deferred<void>();

        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return stream.response;
                if (url.pathname === "/catalog") {
                    await held.promise;
                    // Taken at the old position, so the event below is strictly
                    // after it and the snapshot cannot already contain it.
                    return new Response(
                        JSON.stringify(catalog([session(OLD_VERSION, "Before")], OLD_VERSION)),
                        { status: 200 },
                    );
                }
                throw new Error(`Unexpected request to ${url.pathname}`);
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });

        try {
            stream.write(liveHello(OLD_VERSION, false, false));
            await settle();

            // The client has loaded nothing yet, so this names a session it has
            // never heard of. It has to survive until the snapshot introduces it.
            stream.write(titleEvent("After"));
            await settle();

            held.resolve();
            await settle();

            const listed = connection
                .projects()
                .flatMap((project) => project.sessions ?? [])
                .find((entry) => entry.id === "session-1");
            expect(listed?.title).toBe("After");
        } finally {
            connection.close();
            rig.close();
        }
    });

    it("reloads the catalog on a gap, and not on a clean resume", async () => {
        const stream = streamResponse();
        let catalogRequests = 0;
        let gitWatchRequests = 0;
        const rig = connectRig({
            endpoint: "http://daemon.test",
            fetch: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === "/events/live") return stream.response;
                if (url.pathname === "/catalog") {
                    catalogRequests += 1;
                    return new Response(JSON.stringify(catalog([session(OLD_VERSION, "Before")])), {
                        status: 200,
                    });
                }
                if (url.pathname === "/git/watch") {
                    gitWatchRequests += 1;
                    return new Response(JSON.stringify({ snapshots: [] }), { status: 200 });
                }
                throw new Error(`Unexpected request to ${url.pathname}`);
            },
            randomValues,
            token: "secret",
        });
        const connection = rig.connectGroups({ onChange: () => undefined });

        try {
            // First connection: the client holds nothing, so it must load.
            stream.write(liveHello(OLD_VERSION, false, false));
            await settle();
            expect(catalogRequests).toBe(1);
            expect(gitWatchRequests).toBe(1);

            // A clean resume already replayed every missed event, so the entities
            // it holds are current and re-fetching them is pure waste.
            stream.write(liveHello(OLD_VERSION, false, true));
            await settle();
            expect(catalogRequests).toBe(1);
            expect(gitWatchRequests).toBe(1);

            // A gap means events were lost, so what it holds may be stale.
            stream.write(liveHello(NEW_VERSION, true, false));
            await settle();
            expect(catalogRequests).toBe(2);
            expect(gitWatchRequests).toBe(2);
        } finally {
            connection.close();
            rig.close();
        }
    });
});
