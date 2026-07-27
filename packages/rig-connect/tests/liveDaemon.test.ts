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
import { InMemorySessionStore } from "../../rig/sources/server/InMemorySessionStore.js";
import { createProtocolHttpServer } from "../../rig/sources/server/createProtocolHttpServer.js";
import { connectSession } from "@/connectSession.js";
import type { SessionConnection } from "@/connectSession.js";

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
            ? new InMemorySessionStore({
                  createRuntime: (runtimeOptions) =>
                      createRuntime(runtimeOptions, options.inferenceGate),
                  modelCatalog: testCatalog(),
              })
            : new InMemorySessionStore();
    const server = createProtocolHttpServer({ store, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    started.push({
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    });
    return { endpoint: `http://127.0.0.1:${port}`, store };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

describe("rig-connect against a live daemon", () => {
    let connection: SessionConnection | undefined;

    afterEach(() => {
        connection?.close();
        connection = undefined;
    });

    it("receives the whole session on the opening frame", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-connect-test" });

        let changes = 0;
        connection = connectSession({
            endpoint,
            onChange: () => {
                changes += 1;
            },
            sessionId: session.id,
            token: "secret",
        });

        await waitFor(() => connection?.session().connection === "live", "the stream to open");
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
            projectId: session.snapshot().projectId,
            sessionId: session.id,
            shellCommands: [],
            subagents: [],
            tasks: [],
        });
    });

    it("tracks what the session is doing without asking the daemon anything else", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-connect-test" });

        connection = connectSession({
            endpoint,
            onChange: () => undefined,
            sessionId: session.id,
            token: "secret",
        });
        await waitFor(() => connection?.session().connection === "live", "the stream to open");

        await session.changePermissionMode({ permissionMode: "read_only" });
        await waitFor(
            () => connection?.session().activity !== undefined,
            "the session activity to arrive",
        );

        expect(connection.session().activity.kind).toBe("idle");
        expect(connection.session().activity.label).toBe("Idle");
    });

    it("reports the session title as the daemon learns it", async () => {
        const { endpoint, store } = await startDaemon();
        const session = store.create({ cwd: "/tmp/rig-connect-test" });

        connection = connectSession({
            endpoint,
            onChange: () => undefined,
            sessionId: session.id,
            token: "secret",
        });
        await waitFor(() => connection?.session().connection === "live", "the stream to open");

        session.events.append({
            createdAt: Date.now(),
            data: { status: "ready", title: "Ship rig-connect" },
            id: session.events.lastEventId() ?? "",
            sessionId: session.id,
            type: "session_title_changed",
        } as never);

        await waitFor(
            () => connection?.session().title === "Ship rig-connect",
            "the title to arrive",
        );
    });

    it("delivers real turn boundaries to a client that attaches after the work", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = store.create({ cwd: "/tmp/rig-connect-test" });

        // The work happens before anyone is watching, so everything the client
        // renders has to come from the opening frame.
        const first = session.submit({ text: "First ask." });
        await session.waitForRun(first.runId);
        const second = session.submit({ text: "Second ask." });
        await session.waitForRun(second.runId);

        connection = connectSession({
            endpoint,
            onChange: () => undefined,
            sessionId: session.id,
            token: "secret",
        });
        await waitFor(() => connection?.session().connection === "live", "the stream to open");

        const elements = connection.elements();
        const ends = elements.filter((element) => element.kind === "turn_end");
        expect(ends).toHaveLength(2);
        expect(ends.every((element) => element.turnId.startsWith("history:"))).toBe(false);
        const events = session.events.since(undefined) ?? [];
        const firstSubmitted = events.find(
            (event) => event.type === "message_submitted" && event.data.runId === first.runId,
        );
        const firstFinished = events.find(
            (event) => event.type === "run_finished" && event.data.runId === first.runId,
        );
        expect(ends[0]).toMatchObject({
            endedAt: firstFinished?.createdAt,
            startedAt: firstSubmitted?.createdAt,
        });
        expect(connection.session().usage).toMatchObject({
            currentProviderId: "test",
            totalCost: 0.2,
            totalTokens: 24,
        });
        expect(elements.at(-1)?.kind).toBe("turn_end");
        expect(connection.session().transcriptComplete).toBe(true);
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
        const session = store.create({ cwd: "/tmp/rig-connect-test" });
        connection = connectSession({
            endpoint,
            onChange: () => undefined,
            sessionId: session.id,
            token: "secret",
        });
        await waitFor(() => connection?.session().connection === "live", "the stream to open");

        const submitted = session.submit({ text: "Keep this clock." });
        const submission = (session.events.since(undefined) ?? []).find(
            (event) => event.type === "message_submitted" && event.data.runId === submitted.runId,
        );
        await waitFor(
            () => connection?.session().activeTurn?.turnId === submitted.runId,
            "the active turn timing to arrive",
        );
        expect(connection.session().activeTurn).toEqual({
            startedAt: submission?.createdAt,
            turnId: submitted.runId,
        });

        releaseInference();
        await session.waitForRun(submitted.runId);
        await waitFor(
            () =>
                connection
                    ?.elements()
                    .some((element) => element.id === `turn:${submitted.runId}`) === true,
            "the completed turn timing to arrive",
        );
        const end = connection
            .elements()
            .find((element) => element.id === `turn:${submitted.runId}`);
        expect(connection.session().activeTurn).toBeUndefined();
        expect(end).toMatchObject({
            elapsedMs: expect.any(Number),
            endedAt: expect.any(Number),
            startedAt: submission?.createdAt,
        });
        expect(connection.session().usage).toMatchObject({
            totalCost: 0.1,
            totalTokens: 12,
        });
    });

    it("says so when the conversation began before the window it was given", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = store.create({ cwd: "/tmp/rig-connect-test" });
        for (let index = 0; index < 22; index += 1) {
            const submitted = session.submit({ text: `Ask ${index}.` });
            await session.waitForRun(submitted.runId);
        }

        connection = connectSession({
            endpoint,
            onChange: () => undefined,
            sessionId: session.id,
            token: "secret",
        });
        await waitFor(() => connection?.session().connection === "live", "the stream to open");

        // A client must be able to tell that earlier turns exist rather than
        // presenting a truncated window as the whole conversation.
        expect(connection.session().transcriptComplete).toBe(false);
        expect(connection.elements().filter((element) => element.kind === "turn_end")).toHaveLength(
            20,
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
    let connection: SessionConnection | undefined;

    afterEach(() => {
        connection?.close();
        connection = undefined;
    });

    it("pages back to the beginning of a real conversation", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = store.create({ cwd: "/tmp/rig-load-earlier" });
        for (const text of ["One.", "Two.", "Three."]) {
            const submitted = session.submit({ text });
            await session.waitForRun(submitted.runId);
        }

        // One turn at a time, so the opening frame is deliberately short of the
        // conversation and a reader has something to scroll back into.
        connection = connectSession({
            endpoint,
            onChange: () => undefined,
            sessionId: session.id,
            token: "secret",
            transcriptTurnLimit: 1,
        });
        await waitFor(() => connection?.session().connection === "live", "the stream to open");
        expect(connection.session().transcriptComplete).toBe(false);
        const newest = connection.elements().map((element) => element.id);

        const loadOnePage = async (): Promise<void> => {
            const token = connection?.session().loadMoreToken;
            if (connection === undefined || token === undefined) {
                throw new Error("Expected a load-more token.");
            }
            connection.loadMore(token);
            await waitFor(
                () =>
                    connection?.session().loadingMore === false &&
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
    });
});

describe("paging back through a transcript", () => {
    it("serves the turns before an anchor, and refuses a missing one", async () => {
        const { endpoint, store } = await startDaemon({ withModel: true });
        const session = store.create({ cwd: "/tmp/rig-transcript-page" });
        for (const text of ["One.", "Two.", "Three."]) {
            const submitted = session.submit({ text });
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
