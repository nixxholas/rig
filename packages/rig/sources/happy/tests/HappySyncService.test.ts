import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalog } from "../../protocol/index.js";
import { openSessionDatabase } from "../../persistence/database/openSessionDatabase.js";
import { sessionEvents } from "../../persistence/database/schema.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createHappySpawnSessionId } from "../createHappySpawnSessionId.js";
import { decryptHappyPayload, encryptHappyPayload } from "../happyEncryption.js";
import { HappySyncRepository } from "../HappySyncRepository.js";
import { HappySyncService } from "../HappySyncService.js";
import type { HappyConnectionConfiguration } from "../types.js";

const directories: string[] = [];
const ctx = createTestRootContext().named("happy-sync-service-test");

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe("HappySyncService machine spawning", () => {
    it("creates, synchronizes, and idempotently retries a persistent session through encrypted RPC", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const workspace = join(directory, "workspace");
        await mkdir(workspace);
        const secret = new Uint8Array(32).fill(7);
        const modelCatalog = catalog();
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret, type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            machineId: "rig-machine-1",
            serverUrl: "https://happy.example",
        };
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog,
        });
        const sockets = new Map<string, FakeSocket>();
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/machines") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    machine: {
                        daemonStateVersion: 0,
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-1",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-1/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            return new Response("Not found", { status: 404 });
        });
        const service = await HappySyncService.open(ctx, {
            configuration,
            createSession: (requestCtx, id, sessionRequest) =>
                store.createWithId(requestCtx, id, sessionRequest),
            databasePath,
            fetch: request,
            modelCatalog,
            socketFactory: (_url, options) => {
                const auth = options?.auth as { clientType?: unknown } | undefined;
                const clientType = String(auth?.clientType);
                const socket = new FakeSocket();
                sockets.set(clientType, socket);
                return socket;
            },
        });
        await service.start(ctx);
        await waitFor(() => sockets.get("machine-scoped")?.connected === true);
        const machine = sockets.get("machine-scoped")!;
        const params = {
            agent: "rig",
            clientRequestId: "mobile-request-1",
            directory: workspace,
            type: "spawn-in-directory",
        };
        const encryptedParams = Buffer.from(encryptHappyPayload(secret, "legacy", params)).toString(
            "base64",
        );

        const first = await machine.requestRpc({
            method: "rig-machine-1:spawn-happy-session",
            params: encryptedParams,
        });
        const second = await machine.requestRpc({
            method: "rig-machine-1:spawn-happy-session",
            params: encryptedParams,
        });

        expect(decode(secret, first)).toEqual({ sessionId: "happy-session-1", type: "success" });
        expect(decode(secret, second)).toEqual({ sessionId: "happy-session-1", type: "success" });
        const localSessionId = createHappySpawnSessionId("rig-machine-1", "mobile-request-1");
        expect((await store.get(ctx, localSessionId))?.snapshot()).toMatchObject({
            cwd: workspace,
            permissionMode: "auto",
        });
        expect(await store.list(ctx)).toHaveLength(1);

        await service.close(ctx);
        const requestsAfterClose = request.mock.calls.length;
        await service.attach(ctx, await store.create(ctx, { cwd: workspace }));
        await service.start(ctx);
        await Promise.resolve();
        expect(request).toHaveBeenCalledTimes(requestsAfterClose);
        await store.close(ctx);
    });

    it("keeps session synchronization available when machine metadata cannot be built", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-isolation-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const validCatalog = catalog();
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: validCatalog,
        });
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-isolated",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-isolated/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            return new Response("Not found", { status: 404 });
        });
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const service = await HappySyncService.open(ctx, {
            configuration: {
                credentials: {
                    encryption: { secret: new Uint8Array(32).fill(3), type: "legacy" },
                    token: "happy-token",
                },
                credentialsPath: join(directory, "access.key"),
                happyHome: join(directory, "happy"),
                imported: false,
                machineId: "rig-machine-invalid-catalog",
                serverUrl: "https://happy.example",
            },
            createSession: (requestCtx, id, sessionRequest) =>
                store.createWithId(requestCtx, id, sessionRequest),
            databasePath,
            fetch: request,
            modelCatalog: { ...validCatalog, defaultModelId: "missing-model" },
            socketFactory: () => new FakeSocket(),
        });
        try {
            await service.attach(ctx, await store.create(ctx, { cwd: directory }));
            await waitFor(() =>
                request.mock.calls.some(([input]) => String(input).endsWith("/v1/sessions")),
            );
            expect(log).toHaveBeenCalledWith(
                expect.stringContaining("machine sync is unavailable"),
            );
        } finally {
            await service.close(ctx);
            await store.close(ctx);
            log.mockRestore();
        }
    });
});

describe("HappySyncService daemon restart", () => {
    it("drains ready delivery work when its projection cursor fell outside the retained event tail", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-gap-delivery-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret: new Uint8Array(32).fill(12), type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        const posted: string[] = [];
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-gap-delivery",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname.endsWith("/messages")) {
                if (init?.method === "POST") {
                    const body = JSON.parse(String(init.body)) as {
                        messages: Array<{ localId: string }>;
                    };
                    posted.push(...body.messages.map((message) => message.localId));
                    return Response.json({});
                }
                return Response.json({ hasMore: false, messages: [] });
            }
            return new Response("Not found", { status: 404 });
        });
        const createService = () =>
            HappySyncService.open(ctx, {
                configuration,
                databasePath,
                fetch: request,
                socketFactory: () => new FakeSocket(),
            });
        const firstStore = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const session = await firstStore.create(ctx, { cwd: directory });
        await session.submitContext(ctx, {
            clientSubmissionId: "gap-history",
            text: "Establish the projection cursor.",
        });
        const firstService = await createService();
        await firstService.attach(ctx, session);
        await waitFor(() => posted.includes("rig:gap-history"));
        await firstService.close(ctx);
        await firstStore.close(ctx);

        const repository = await HappySyncRepository.open(ctx, databasePath);
        await repository.enqueue(ctx, session.id, [
            {
                content: {
                    ev: { t: "service", text: "Must still drain" },
                    id: "ready-before-gap",
                    role: "agent",
                    time: 1,
                },
                localId: "ready-before-gap",
                meta: { sentFrom: "rig" },
                role: "session",
            },
        ]);
        await repository.close(ctx);
        const opened = await openSessionDatabase(ctx, databasePath);
        await opened.ctx.tx
            .insert(sessionEvents)
            .values(
                Array.from({ length: 4_097 }, (_, index) => ({
                    createdAtMs: index + 10,
                    dataJson: JSON.stringify({
                        message: {
                            blocks: [{ text: `Notice ${String(index)}`, type: "text" }],
                            id: `gap-notice-${String(index)}`,
                            role: "system",
                        },
                    }),
                    eventId: `gap-event-${String(index)}`,
                    sessionId: session.id,
                    type: "system_notice" as const,
                })),
            )
            .run();
        await opened.database.close(opened.ctx);

        posted.length = 0;
        const restartedStore = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const restored = await restartedStore.get(ctx, session.id);
        if (restored === undefined) throw new Error("Expected the session to restore.");
        const restartedService = await createService();
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            await restartedService.attach(ctx, restored);
            await waitFor(() => posted.includes("ready-before-gap"));
            expect(await repositoryState(databasePath, session.id)).toMatchObject({
                projectionStallCause: "gap",
                projectionStatus: "stalled",
            });
        } finally {
            errors.mockRestore();
            await restartedService.close(ctx);
            await restartedStore.close(ctx);
        }
    });

    it("coalesces concurrent attaches into one client and closes that client", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-concurrent-attach-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const sockets: FakeSocket[] = [];
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-concurrent-attach",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname.endsWith("/messages")) {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            return new Response("Not found", { status: 404 });
        });
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const session = await store.create(ctx, { cwd: directory });
        const service = await HappySyncService.open(ctx, {
            configuration: {
                credentials: {
                    encryption: { secret: new Uint8Array(32).fill(9), type: "legacy" },
                    token: "happy-token",
                },
                credentialsPath: join(directory, "access.key"),
                happyHome: join(directory, "happy"),
                imported: false,
                serverUrl: "https://happy.example",
            },
            databasePath,
            fetch: request,
            socketFactory: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        });

        try {
            await Promise.all([service.attach(ctx, session), service.attach(ctx, session)]);
            await waitFor(() =>
                sockets.some((socket) =>
                    socket.emitted.some(([event]) => event === "session-alive"),
                ),
            );

            expect(sockets).toHaveLength(1);
            expect(
                request.mock.calls.filter(
                    ([input, init]) =>
                        new URL(String(input)).pathname === "/v1/sessions" &&
                        init?.method === "POST",
                ),
            ).toHaveLength(1);
            await service.close(ctx);
            expect(sockets).toHaveLength(1);
            expect(sockets[0]?.connected).toBe(false);
        } finally {
            await service.close(ctx);
            await store.close(ctx);
        }
    });

    it("does not construct a client when close wins an in-flight attach", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-close-attach-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const session = await store.create(ctx, { cwd: directory });
        const actualEnsureSession = HappySyncRepository.prototype.ensureSession;
        let releaseEnsure: (() => void) | undefined;
        const ensureReleased = new Promise<void>((resolve) => {
            releaseEnsure = resolve;
        });
        let notifyEnsure: (() => void) | undefined;
        const ensureCompleted = new Promise<void>((resolve) => {
            notifyEnsure = resolve;
        });
        vi.spyOn(HappySyncRepository.prototype, "ensureSession").mockImplementation(
            async function (this: HappySyncRepository, requestCtx, options) {
                const state = await actualEnsureSession.call(this, requestCtx, options);
                notifyEnsure?.();
                await ensureReleased;
                return state;
            },
        );
        const sockets: FakeSocket[] = [];
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const service = await HappySyncService.open(ctx, {
            configuration: {
                credentials: {
                    encryption: { secret: new Uint8Array(32).fill(10), type: "legacy" },
                    token: "happy-token",
                },
                credentialsPath: join(directory, "access.key"),
                happyHome: join(directory, "happy"),
                imported: false,
                serverUrl: "https://happy.example",
            },
            databasePath,
            fetch: async () => new Response("Unexpected network request", { status: 500 }),
            socketFactory: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        });

        try {
            const attaching = service.attach(ctx, session);
            await ensureCompleted;
            expect(service.shouldAttachOnAccess(session)).toBe(false);
            const closing = service.close(ctx);
            releaseEnsure?.();

            await expect(Promise.all([attaching, closing])).resolves.toBeDefined();
            expect(sockets).toEqual([]);
            expect(errors).not.toHaveBeenCalled();
        } finally {
            releaseEnsure?.();
            await service.close(ctx);
            await store.close(ctx);
        }
    });

    it("backfills history once, skips it after cold restore, and still sends new events", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-cold-attach-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret: new Uint8Array(32).fill(8), type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        const postedLocalIds: string[][] = [];
        const sockets: FakeSocket[] = [];
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        active: true,
                        id: "happy-session-cold-attach",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-cold-attach/messages") {
                if (init?.method === "POST") {
                    const body = JSON.parse(String(init.body)) as {
                        messages: Array<{ localId: string }>;
                    };
                    postedLocalIds.push(body.messages.map((message) => message.localId));
                    return Response.json({});
                }
                return Response.json({ hasMore: false, messages: [] });
            }
            return new Response("Not found", { status: 404 });
        });
        const createService = async () =>
            await HappySyncService.open(ctx, {
                configuration,
                databasePath,
                fetch: request,
                socketFactory: () => {
                    const socket = new FakeSocket();
                    sockets.push(socket);
                    return socket;
                },
            });
        const firstStore = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const session = await firstStore.create(ctx, { cwd: directory });
        await session.submitContext(ctx, {
            clientSubmissionId: "historical-message",
            text: "Synchronize this history once.",
        });
        // A live-only cursor may be newer than the last durable event. Happy projection progress
        // must anchor to the durable event log rather than treating this draft as its source.
        await session.setDraft(ctx, { draft: "Not a durable Happy projection event." });
        const firstService = await createService();
        let restartedService: HappySyncService | undefined;
        let restartedStore: PersistentSessionStore | undefined;

        try {
            await firstService.attach(ctx, session);
            await waitFor(() => postedLocalIds.flat().includes("rig:historical-message"));
            await firstService.close(ctx);
            await firstStore.close(ctx);

            restartedStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog(),
            });
            restartedService = await createService();
            const restored = await restartedStore.get(ctx, session.id);
            if (restored === undefined) throw new Error("Expected the session to be restored.");
            await restartedService.attach(ctx, restored);
            await waitFor(
                () => sockets[1]?.emitted.some(([event]) => event === "session-alive") === true,
            );

            expect(
                postedLocalIds.flat().filter((id) => id === "rig:historical-message"),
            ).toHaveLength(1);

            await restored.submitContext(ctx, {
                clientSubmissionId: "new-message",
                text: "Synchronize this new event.",
            });
            const newEvent = restored.events
                .since(undefined)
                ?.find(
                    (event) =>
                        event.type === "message_submitted" &&
                        event.data.message.id === "new-message",
                );
            if (newEvent === undefined) throw new Error("Expected the new event to be recorded.");
            await restartedService.observe(ctx, newEvent, restored);
            await waitFor(() => postedLocalIds.flat().includes("rig:new-message"));
        } finally {
            await restartedService?.close(ctx);
            await restartedStore?.close(ctx);
            await firstService.close(ctx);
            await firstStore.close(ctx);
        }
    });

    it("recovers only the missed event after a full outbox and daemon restart", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-outbox-recovery-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret: new Uint8Array(32).fill(7), type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        const postedLocalIds: string[] = [];
        let deliveryAvailable = true;
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        active: true,
                        id: "happy-session-outbox-recovery",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname.endsWith("/messages")) {
                if (init?.method !== "POST") {
                    return Response.json({ hasMore: false, messages: [] });
                }
                if (!deliveryAvailable) return new Response("offline", { status: 503 });
                const body = JSON.parse(String(init.body)) as {
                    messages: Array<{ localId: string }>;
                };
                postedLocalIds.push(...body.messages.map((message) => message.localId));
                return Response.json({});
            }
            return new Response("Not found", { status: 404 });
        });
        const createService = () =>
            HappySyncService.open(ctx, {
                configuration,
                databasePath,
                fetch: request,
                maxPendingMessagesPerSession: 1,
                socketFactory: () => new FakeSocket(),
            });
        const firstStore = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const session = await firstStore.create(ctx, { cwd: directory });
        await session.submitContext(ctx, {
            clientSubmissionId: "historical-message",
            text: "Already synchronized.",
        });
        const firstService = await createService();
        let restartedStore: PersistentSessionStore | undefined;
        let restartedService: HappySyncService | undefined;
        try {
            await firstService.attach(ctx, session);
            await waitFor(() => postedLocalIds.includes("rig:historical-message"));

            deliveryAvailable = false;
            const repository = await HappySyncRepository.open(ctx, databasePath);
            await repository.enqueue(ctx, session.id, [
                {
                    content: {
                        ev: { t: "service", text: "filler" },
                        id: "filler",
                        role: "agent",
                        time: 1,
                    },
                    localId: "filler",
                    meta: { sentFrom: "rig" },
                    role: "session",
                },
            ]);
            await session.submitContext(ctx, {
                clientSubmissionId: "missed-message",
                text: "Must survive restart.",
            });
            const missed = session.events
                .since(undefined)
                ?.find(
                    (event) =>
                        event.type === "message_submitted" &&
                        event.data.message.id === "missed-message",
                );
            if (missed === undefined) throw new Error("Expected a durable missed event.");
            await firstService.observe(ctx, missed, session);
            expect((await repository.getSession(ctx, session.id))?.projectedEventId).toBe(
                missed.id,
            );
            await firstService.close(ctx);
            await repository.close(ctx);
            await firstStore.close(ctx);

            deliveryAvailable = true;
            restartedStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog(),
            });
            const restored = await restartedStore.get(ctx, session.id);
            if (restored === undefined) throw new Error("Expected the session to restore.");
            restartedService = await createService();
            await restartedService.attach(ctx, restored);
            await waitFor(() => postedLocalIds.includes("rig:missed-message"));

            expect(
                postedLocalIds.filter((localId) => localId === "rig:historical-message"),
            ).toHaveLength(1);
            expect(
                postedLocalIds.filter((localId) => localId === "rig:missed-message"),
            ).toHaveLength(1);
            expect(postedLocalIds.indexOf("filler")).toBeLessThan(
                postedLocalIds.indexOf("rig:missed-message"),
            );
        } finally {
            await restartedService?.close(ctx);
            await restartedStore?.close(ctx);
            await firstService.close(ctx);
            await firstStore.close(ctx);
        }
    });

    it("does not reload or reconnect historical sessions during startup", async () => {
        const ctx = createTestRootContext().named("happy-sync-no-restore");
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-restart-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret: new Uint8Array(32).fill(4), type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        const sockets: FakeSocket[] = [];
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        active: true,
                        id: "happy-session-restarted",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-restarted/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            return new Response("Not found", { status: 404 });
        });
        const createService = async () =>
            await HappySyncService.open(ctx, {
                configuration,
                databasePath,
                fetch: request,
                socketFactory: () => {
                    const socket = new FakeSocket();
                    sockets.push(socket);
                    return socket;
                },
            });
        const firstStore = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const session = await firstStore.create(ctx, { cwd: directory });
        const firstService = await createService();
        let restartedService: HappySyncService | undefined;
        let restartedStore: PersistentSessionStore | undefined;

        try {
            await firstService.attach(ctx, session);
            await waitFor(() => sockets[0]?.connected === true);
            await firstService.close(ctx);
            await firstStore.close(ctx);

            restartedStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog(),
            });
            restartedService = await createService();
            await restartedService.start(ctx);

            expect(sockets).toHaveLength(1);
        } finally {
            await restartedService?.close(ctx);
            await restartedStore?.close(ctx);
            await firstService.close(ctx);
            await firstStore.close(ctx);
        }
    });

    it("does not reconnect either live or archived historical sessions", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-restore-scope-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret: new Uint8Array(32).fill(6), type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        const sockets: FakeSocket[] = [];
        let remoteSessionCount = 0;
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                remoteSessionCount += 1;
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        active: true,
                        id: `happy-session-scope-${String(remoteSessionCount)}`,
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname.endsWith("/messages")) {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            if (url.pathname.endsWith("/archive")) return Response.json({ success: true });
            return new Response("Not found", { status: 404 });
        });
        const createService = async () =>
            await HappySyncService.open(ctx, {
                configuration,
                databasePath,
                fetch: request,
                socketFactory: () => {
                    const socket = new FakeSocket();
                    sockets.push(socket);
                    return socket;
                },
            });
        const firstStore = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const archived = await firstStore.create(ctx, { cwd: directory });
        const live = await firstStore.create(ctx, { cwd: directory });
        const firstService = await createService();
        let restartedService: HappySyncService | undefined;
        let restartedStore: PersistentSessionStore | undefined;

        try {
            await firstService.attach(ctx, archived);
            await firstService.attach(ctx, live);
            await waitFor(
                () => sockets.length === 2 && sockets.every((socket) => socket.connected),
            );
            await archived.setArchived(ctx, true);
            await firstService.close(ctx);
            await firstStore.close(ctx);

            restartedStore = await PersistentSessionStore.open(ctx, {
                databasePath,
                modelCatalog: catalog(),
            });
            restartedService = await createService();
            await restartedService.start(ctx);

            expect(sockets).toHaveLength(2);
            expect(remoteSessionCount).toBe(2);
        } finally {
            await restartedService?.close(ctx);
            await restartedStore?.close(ctx);
            await firstService.close(ctx);
            await firstStore.close(ctx);
        }
    });
});

describe("HappySyncService session archival", () => {
    it("ends Happy synchronization and does not reattach an archived Rig session", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-happy-service-archive-"));
        directories.push(directory);
        const databasePath = join(directory, "sessions.sqlite");
        const store = await PersistentSessionStore.open(ctx, {
            databasePath,
            modelCatalog: catalog(),
        });
        const sockets: FakeSocket[] = [];
        const secret = new Uint8Array(32).fill(5);
        const configuration: HappyConnectionConfiguration = {
            credentials: {
                encryption: { secret, type: "legacy" },
                token: "happy-token",
            },
            credentialsPath: join(directory, "access.key"),
            happyHome: join(directory, "happy"),
            imported: false,
            serverUrl: "https://happy.example",
        };
        let archiveResponseCount = 0;
        let resolveFirstArchive: ((response: Response) => void) | undefined;
        const firstArchive = new Promise<Response>((resolve) => {
            resolveFirstArchive = resolve;
        });
        const request = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v1/sessions") {
                const body = JSON.parse(String(init?.body)) as { metadata: string };
                return Response.json({
                    session: {
                        id: "happy-session-archive",
                        metadata: body.metadata,
                        metadataVersion: 0,
                    },
                });
            }
            if (url.pathname === "/v3/sessions/happy-session-archive/messages") {
                return Response.json(
                    init?.method === "POST" ? {} : { hasMore: false, messages: [] },
                );
            }
            if (url.pathname === "/v1/sessions/happy-session-archive/archive") {
                archiveResponseCount += 1;
                if (archiveResponseCount === 1) return firstArchive;
                return Response.json({ success: true });
            }
            return new Response("Not found", { status: 404 });
        });
        const createService = async () =>
            await HappySyncService.open(ctx, {
                configuration,
                databasePath,
                fetch: request,
                modelCatalog: catalog(),
                socketFactory: () => {
                    const socket = new FakeSocket();
                    sockets.push(socket);
                    return socket;
                },
            });
        const service = await createService();
        let restartedService: HappySyncService | undefined;
        const session = await store.create(ctx, { cwd: directory });

        try {
            expect(service.shouldAttachOnAccess(session)).toBe(true);
            await service.attach(ctx, session);
            await waitFor(
                () => sockets[0]?.emitted.some(([event]) => event === "session-alive") === true,
            );
            expect(service.shouldAttachOnAccess(session)).toBe(false);

            const fullSnapshot = vi.spyOn(session, "snapshot");
            await service.attach(ctx, session);
            expect(fullSnapshot).not.toHaveBeenCalled();
            fullSnapshot.mockRestore();

            await session.setArchived(ctx, true);
            const archivedEvent = session.events.since(undefined)?.at(-1);
            if (archivedEvent === undefined) throw new Error("The archive event was not recorded.");
            const observedFullSnapshot = vi.spyOn(session, "snapshot");
            await service.observe(ctx, archivedEvent, session);
            expect(service.shouldAttachOnAccess(session)).toBe(false);
            expect(observedFullSnapshot).not.toHaveBeenCalled();
            observedFullSnapshot.mockRestore();

            await waitFor(
                () => sockets[0]?.emitted.some(([event]) => event === "session-end") === true,
            );
            await waitFor(() => archiveRequestCount(request) === 1);
            expect(
                sockets[0]?.emitted.find(([event]) => event === "session-end")?.[1],
            ).toMatchObject({
                sid: "happy-session-archive",
            });
            const archivedMetadata = decryptMetadata(
                secret,
                sockets[0]?.emitted.filter(([event]) => event === "update-metadata").at(-1)?.[1]
                    .metadata,
            );
            expect(archivedMetadata).toMatchObject({
                archiveReason: "Session archived in Rig",
                archivedBy: "rig",
                lifecycleState: "archived",
            });

            await service.attach(ctx, session);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(sockets).toHaveLength(1);

            await session.setArchived(ctx, false);
            const restoredEvent = session.events.since(undefined)?.at(-1);
            if (restoredEvent === undefined) throw new Error("The restore event was not recorded.");
            await service.observe(ctx, restoredEvent, session);
            await service.attach(ctx, session);

            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(sockets).toHaveLength(1);
            resolveFirstArchive?.(Response.json({ success: true }));

            await waitFor(
                () =>
                    decryptMetadata(
                        secret,
                        sockets[1]?.emitted
                            .filter(([event]) => event === "update-metadata")
                            .at(-1)?.[1].metadata,
                    )?.lifecycleState === "running",
            );
            const restoredMetadata = decryptMetadata(
                secret,
                sockets[1]?.emitted.filter(([event]) => event === "update-metadata").at(-1)?.[1]
                    .metadata,
            );
            expect(restoredMetadata).not.toHaveProperty("archiveReason");
            expect(restoredMetadata).not.toHaveProperty("archivedBy");
            expect(sockets[0]?.connected).toBe(false);

            await service.close(ctx);
            restartedService = await createService();
            await session.setArchived(ctx, true);
            const restartedArchiveEvent = session.events.since(undefined)?.at(-1);
            if (restartedArchiveEvent === undefined) {
                throw new Error("The restarted archive event was not recorded.");
            }
            await restartedService.observe(ctx, restartedArchiveEvent, session);

            await waitFor(() => archiveRequestCount(request) === 2);
            expect(
                sockets[2]?.emitted.find(([event]) => event === "session-end")?.[1],
            ).toMatchObject({
                sid: "happy-session-archive",
            });
        } finally {
            resolveFirstArchive?.(Response.json({ success: true }));
            await restartedService?.close(ctx);
            await service.close(ctx);
            await store.close(ctx);
        }
    });
});

/*
 * The fake keeps socket events observable because archival has two independent
 * remote effects: encrypted lifecycle metadata and the immediate session-end signal.
 */
class FakeSocket {
    connected = false;
    readonly emitted: Array<[string, any]> = [];
    readonly #listeners = new Map<string, (...values: any[]) => void>();

    connect(): void {
        this.connected = true;
        this.#listeners.get("connect")?.();
    }

    disconnect(): void {
        this.connected = false;
    }

    emit(event: string, ...values: any[]): void {
        this.emitted.push([event, values[0]]);
        const callback = values.at(-1);
        if (typeof callback !== "function") return;
        if (event === "machine-update-metadata") {
            callback({ metadata: values[0].metadata, result: "success", version: 1 });
        } else if (event === "machine-update-state") {
            callback({ daemonState: values[0].daemonState, result: "success", version: 1 });
        } else if (event === "update-metadata") {
            callback({ result: "success", version: 1 });
        }
    }

    on(event: string, listener: (...values: any[]) => void): void {
        this.#listeners.set(event, listener);
    }

    requestRpc(request: unknown): Promise<string> {
        return new Promise((resolve) => this.#listeners.get("rpc-request")?.(request, resolve));
    }
}

function catalog(): ModelCatalog {
    const model = {
        defaultThinkingLevel: "high",
        id: "gpt-test",
        name: "GPT Test",
        thinkingLevels: ["low", "high"],
    } as const;
    return {
        defaultModelId: model.id,
        defaultProviderId: "codex",
        models: [model],
        providers: [{ models: [model], providerId: "codex" }],
    };
}

function decode(secret: Uint8Array, value: string): unknown {
    return decryptHappyPayload(secret, "legacy", Buffer.from(value, "base64"));
}

function archiveRequestCount(request: ReturnType<typeof vi.fn<typeof fetch>>): number {
    return request.mock.calls.filter(
        ([input]) =>
            new URL(String(input)).pathname === "/v1/sessions/happy-session-archive/archive",
    ).length;
}

async function repositoryState(databasePath: string, sessionId: string) {
    const repository = await HappySyncRepository.open(ctx, databasePath);
    try {
        return await repository.getSession(ctx, sessionId);
    } finally {
        await repository.close(ctx);
    }
}

function decryptMetadata(secret: Uint8Array, value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "string") return undefined;
    const decoded = decode(secret, value);
    return typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : undefined;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for Happy synchronization.");
}
