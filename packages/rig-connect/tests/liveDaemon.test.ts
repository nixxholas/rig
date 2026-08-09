import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../rig/sources/agent/index.js";
import { NativeProcessManager } from "../../rig/sources/processes/index.js";
import type { ModelCatalog } from "../../rig/sources/protocol/index.js";
import type { CodingAssistantRuntime } from "../../rig/sources/runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../rig/sources/runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import { InMemorySessionStore } from "../../rig/sources/session/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import {
    connectRig,
    type RigSessionConnection,
    type RigSessionSubscriptionOptions,
} from "@/connectRig.js";

/**
 * These run against the real daemon rather than a scripted stream, because the
 * point of the library is that a client needs nothing but the session stream.
 * A mock cannot show that the daemon really sends enough.
 */

const started: { close: () => Promise<void> }[] = [];

afterEach(async () => {
    for (const server of started.splice(0)) await server.close();
});

async function startDaemon(options: { inferenceGate?: Promise<void>; withModel?: boolean } = {}) {
    const store =
        options.withModel === true
            ? await InMemorySessionStore.open({
                  createRuntime: (runtimeOptions) =>
                      createRuntime(runtimeOptions, options.inferenceGate),
                  modelCatalog: testCatalog(),
              })
            : await InMemorySessionStore.open();
    const server = await createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await store.close();
        },
    });
    return { endpoint: `http://127.0.0.1:${port}`, store };
}

async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

async function withSessionConnection(
    endpoint: string,
    options: RigSessionSubscriptionOptions,
    test: (connection: RigSessionConnection) => Promise<void>,
): Promise<void> {
    const rig = connectRig({ endpoint, token: "secret" });
    const connection = rig.connectSession(options);
    try {
        await test(connection);
    } finally {
        connection.close();
        rig.close();
    }
}

describe("rig-connect against a live daemon", () => {
    it("receives the whole session on the opening frame", async () => {
        const { endpoint, store } = await startDaemon();
        const session = await store.create({ cwd: "/tmp/rig-connect-test" });

        let changes = 0;
        await withSessionConnection(
            endpoint,
            {
                onChange: () => {
                    changes += 1;
                },
                sessionId: session.id,
            },
            async (connection) => {
                await waitFor(
                    () => connection.session().connection === "live",
                    "the stream to open",
                );
                expect(changes).toBeGreaterThan(0);
                expect(connection.session()).toMatchObject({
                    archived: false,
                    backgroundProcesses: [],
                    cwd: "/tmp/rig-connect-test",
                    modelLocked: false,
                    models: expect.any(Array),
                    orderKey: session.snapshot().orderKey,
                    pendingSteeringMessages: [],
                    pendingUserInputs: [],
                    permissionMode: session.snapshot().permissionMode,
                    scope: session.snapshot().scope,
                    sessionId: session.id,
                    shellCommands: [],
                    subagents: [],
                    tasks: [],
                });
            },
        );
    });

    it("delivers expanded optimistic actions through the real mutation protocol", async () => {
        const { endpoint, store } = await startDaemon();
        const source = await store.create({ cwd: "/tmp/rig-connect-actions" });
        const requests: string[] = [];
        const mutationFailures: string[] = [];
        const rig = connectRig({
            endpoint,
            fetch: (input, init) => {
                requests.push(`${init?.method ?? "GET"} ${String(input)}`);
                return fetch(input, init);
            },
            onMutationRejected: (delta) => mutationFailures.push(delta.message),
            token: "secret",
        });
        const session = rig.connectSession({ onChange: () => undefined, sessionId: source.id });
        try {
            await waitFor(() => session.session().connection === "live", "the stream to open");

            rig.setDraft(source.id, "local first");
            expect(session.session().draft).toBe("local first");
            rig.setPermissionMode(source.id, "full_access");
            expect(session.session().permissionMode).toBe("full_access");
            rig.setGoal(source.id, "Finish the connector");
            expect(session.session().goal?.objective).toBe("Finish the connector");

            await waitFor(
                () =>
                    source.snapshot().draft === "local first" &&
                    source.snapshot().permissionMode === "full_access" &&
                    source.snapshot().goal?.objective === "Finish the connector",
                "the daemon to accept the optimistic changes",
            );

            const createdId = rig.createSession({ cwd: "/tmp/rig-created-through-connect" });
            await waitFor(
                async () => (await store.get(createdId)) !== undefined,
                "the new session to exist",
            );
            expect((await store.get(createdId))?.snapshot().cwd).toBe(
                "/tmp/rig-created-through-connect",
            );

            const forkedId = rig.forkSession(createdId);
            await waitFor(
                async () =>
                    (await store.get(forkedId)) !== undefined || mutationFailures.length > 0,
                `the fork to exist; requests: ${requests.join(", ")}`,
            );
            expect(mutationFailures).toEqual([]);
            expect((await store.get(forkedId))?.snapshot().id).toBe(forkedId);
        } finally {
            session.close();
            rig.close();
        }
    });

    it("tracks what the session is doing without asking the daemon anything else", async () => {
        const { endpoint, store } = await startDaemon();
        const session = await store.create({ cwd: "/tmp/rig-connect-test" });

        await withSessionConnection(
            endpoint,
            { onChange: () => undefined, sessionId: session.id },
            async (connection) => {
                await waitFor(
                    () => connection.session().connection === "live",
                    "the stream to open",
                );

                await session.changePermissionMode({ permissionMode: "read_only" });
                await waitFor(
                    () => connection.session().activity !== undefined,
                    "the session activity to arrive",
                );

                expect(connection.session().activity.kind).toBe("idle");
                expect(connection.session().activity.label).toBe("Idle");
            },
        );
    });

    it("reports the session title as the daemon learns it", async () => {
        const { endpoint, store } = await startDaemon();
        const session = await store.create({ cwd: "/tmp/rig-connect-test" });

        await withSessionConnection(
            endpoint,
            { onChange: () => undefined, sessionId: session.id },
            async (connection) => {
                await waitFor(
                    () => connection.session().connection === "live",
                    "the stream to open",
                );

                await session.events.append({
                    createdAt: Date.now(),
                    data: { status: "ready", title: "Ship rig-connect" },
                    id: session.events.lastEventId() ?? "",
                    sessionId: session.id,
                    type: "session_title_changed",
                } as never);

                await waitFor(
                    () => connection.session().title === "Ship rig-connect",
                    "the title to arrive",
                );
            },
        );
    });

    it("delivers real turn boundaries to a client that attaches after the work", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = await store.create({ cwd: "/tmp/rig-connect-test" });

        // The work happens before anyone is watching, so everything the client
        // renders has to come from the opening frame.
        const first = await session.submit({ text: "First ask." });
        await session.waitForRun(first.runId);
        const second = await session.submit({ text: "Second ask." });
        await session.waitForRun(second.runId);

        await withSessionConnection(
            endpoint,
            { onChange: () => undefined, sessionId: session.id },
            async (connection) => {
                await waitFor(
                    () => connection.session().connection === "live",
                    "the stream to open",
                );

                const elements = connection.elements();
                const ends = elements.filter((element) => element.kind === "group_end");
                expect(ends).toHaveLength(2);
                expect(ends.every((element) => element.runId.startsWith("history:"))).toBe(false);
                const events = session.events.since(undefined) ?? [];
                const firstInference = events.find(
                    (event) =>
                        event.type === "agent_event" &&
                        event.data.runId === first.runId &&
                        event.data.event.type === "inference_iteration_start",
                );
                const firstFinished = events.find(
                    (event) => event.type === "run_finished" && event.data.runId === first.runId,
                );
                expect(ends[0]).toMatchObject({
                    endedAt: firstFinished?.createdAt,
                    startedAt: firstInference?.createdAt,
                });
                expect(connection.session().usage).toMatchObject({
                    currentProviderId: "test",
                    totalCost: 0.2,
                    totalTokens: 24,
                });
                expect(elements.at(-1)?.kind).toBe("group_end");
                expect(connection.session().transcriptComplete).toBe(true);
            },
        );
    });

    it("exposes one authoritative active clock from submission through completion", async () => {
        let releaseInference = (): void => undefined;
        const inferenceGate = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        const { endpoint, store } = await startDaemon({
            inferenceGate,
            withModel: true,
        });
        const session = await store.create({ cwd: "/tmp/rig-connect-test" });
        await withSessionConnection(
            endpoint,
            { onChange: () => undefined, sessionId: session.id },
            async (connection) => {
                await waitFor(
                    () => connection.session().connection === "live",
                    "the stream to open",
                );

                const submitted = await session.submit({ text: "Keep this clock." });
                const submission = (session.events.since(undefined) ?? []).find(
                    (event) =>
                        event.type === "message_submitted" && event.data.runId === submitted.runId,
                );
                await waitFor(
                    () => connection.session().activeTurn?.runId === submitted.runId,
                    "the active turn timing to arrive",
                );
                expect(connection.session().activeTurn).toEqual({
                    runId: submitted.runId,
                    startedAt: submission?.createdAt,
                });

                releaseInference();
                await session.waitForRun(submitted.runId);
                await waitFor(
                    () =>
                        connection
                            .elements()
                            .some(
                                (element) =>
                                    element.kind === "group_end" &&
                                    element.runId === submitted.runId,
                            ) === true,
                    "the completed turn timing to arrive",
                );
                const end = connection
                    .elements()
                    .find(
                        (element) =>
                            element.kind === "group_end" && element.runId === submitted.runId,
                    );
                const inferenceStarted = (session.events.since(undefined) ?? []).find(
                    (event) =>
                        event.type === "agent_event" &&
                        event.data.runId === submitted.runId &&
                        event.data.event.type === "inference_iteration_start",
                );
                expect(connection.session().activeTurn).toBeUndefined();
                expect(end).toMatchObject({
                    elapsedMs: expect.any(Number),
                    endedAt: expect.any(Number),
                    startedAt: inferenceStarted?.createdAt,
                });
                expect(connection.session().usage).toMatchObject({
                    totalCost: 0.1,
                    totalTokens: 12,
                });
            },
        );
    });

    it("says so when the conversation began before the window it was given", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = await store.create({ cwd: "/tmp/rig-connect-test" });
        for (let index = 0; index < 22; index += 1) {
            const submitted = await session.submit({ text: `Ask ${index}.` });
            await session.waitForRun(submitted.runId);
        }

        await withSessionConnection(
            endpoint,
            { onChange: () => undefined, sessionId: session.id },
            async (connection) => {
                await waitFor(
                    () => connection.session().connection === "live",
                    "the stream to open",
                );

                // A client must be able to tell that earlier turns exist rather than
                // presenting a truncated window as the whole conversation.
                expect(connection.session().transcriptComplete).toBe(false);
                expect(
                    connection.elements().filter((element) => element.kind === "group_end"),
                ).toHaveLength(20);
            },
        );
    });
});

function testCatalog(): ModelCatalog {
    const model = testModel();
    return {
        defaultModelId: model.id,
        defaultProviderId: "test",
        models: [model],
        providers: [{ models: [model], providerId: "test" }],
    };
}

function testModel() {
    return defineModel({
        defaultThinkingLevel: "off",
        id: "test/live-daemon",
        name: "Live daemon",
        thinkingLevels: ["off"],
    });
}

function testProvider(inferenceGate?: Promise<void>) {
    const model = testModel();
    return defineProvider({
        id: "test",
        models: [model],
        stream() {
            const message = assistantMessage(model.id);
            return createInferenceStream(async function* () {
                yield { type: "start", partial: { ...message, content: [] } };
                await inferenceGate;
                yield { type: "done", reason: "stop", message };
                return message;
            });
        },
    });
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    inferenceGate?: Promise<void>,
): CodingAssistantRuntime {
    const provider = testProvider(inferenceGate);
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        executor: provider,
        processManager,
    };
}

function assistantMessage(model: string): AssistantMessage {
    return {
        api: "test",
        content: [{ text: "Hello", type: "text" }],
        model,
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0.1, output: 0, total: 0.1 },
            input: 10,
            output: 2,
            totalTokens: 12,
        },
    };
}

describe("loading earlier turns through the connection", () => {
    it("pages back to the beginning of a real conversation", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = await store.create({ cwd: "/tmp/rig-load-earlier" });
        for (const text of ["One.", "Two.", "Three."]) {
            const submitted = await session.submit({ text });
            await session.waitForRun(submitted.runId);
        }

        // One turn at a time, so the opening frame is deliberately short of the
        // conversation and a reader has something to scroll back into.
        await withSessionConnection(
            endpoint,
            { onChange: () => undefined, sessionId: session.id, transcriptTurnLimit: 1 },
            async (connection) => {
                await waitFor(
                    () => connection.session().connection === "live",
                    "the stream to open",
                );
                expect(connection.session().transcriptComplete).toBe(false);
                const newest = connection.elements().map((element) => element.id);

                const loadOnePage = async (): Promise<void> => {
                    const token = connection.session().loadMoreToken;
                    if (token === undefined) throw new Error("Expected a load-more token.");
                    connection.loadMore(token);
                    await waitFor(
                        () =>
                            connection.session().loadingMore === false &&
                            (connection.session().loadMoreToken !== token ||
                                connection.session().transcriptComplete),
                        "the earlier transcript page to load",
                    );
                };

                if (!connection.session().transcriptComplete) await loadOnePage();

                const afterOnePage = connection.elements().map((element) => element.id);
                // History is added in front, so what a reader is looking at keeps both
                // its position relative to the end and its identity.
                expect(afterOnePage.slice(-newest.length)).toEqual(newest);
                expect(afterOnePage.length).toBeGreaterThan(newest.length);

                if (!connection.session().transcriptComplete) await loadOnePage();

                expect(connection.session().transcriptComplete).toBe(true);
                expect(connection.session().loadMoreError).toBeUndefined();
                // Nothing older remains, so further requests are refused rather than
                // repeating the first page forever.
                const settled = connection.elements().map((element) => element.id);
                connection.loadMore("stale-message-token");
                expect(connection.elements().map((element) => element.id)).toEqual(settled);
            },
        );
    });
});

describe("paging back through a transcript", () => {
    it("serves the turns before an anchor, and refuses a missing one", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = await store.create({ cwd: "/tmp/rig-transcript-page" });
        for (const text of ["One.", "Two.", "Three."]) {
            const submitted = await session.submit({ text });
            await session.waitForRun(submitted.runId);
        }

        const newest = await fetchJson(endpoint, `/sessions/${session.id}/transcript`);
        expect(newest.status).toBe(200);
        const runIds = (newest.body as { turns: { runId: string }[] }).turns.map(
            (turn) => turn.runId,
        );
        expect(runIds).toHaveLength(3);

        const page = await fetchJson(
            endpoint,
            `/sessions/${session.id}/transcript?before=${runIds[1]}`,
        );
        // The anchor is the oldest turn already held, so the page stops before it
        // and reports that there is nothing older left.
        expect(
            (page.body as { turns: { runId: string }[] }).turns.map((turn) => turn.runId),
        ).toEqual([runIds[0]]);
        expect((page.body as { complete: boolean }).complete).toBe(true);

        const gone = await fetchJson(
            endpoint,
            `/sessions/${session.id}/transcript?before=run-that-never-existed`,
        );
        expect(gone.status).toBe(409);
    });
});

async function fetchJson(
    endpoint: string,
    path: string,
): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${endpoint}${path}`, {
        headers: { authorization: "Bearer secret" },
    });
    return { body: await response.json(), status: response.status };
}
