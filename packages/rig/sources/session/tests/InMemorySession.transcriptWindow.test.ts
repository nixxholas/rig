import { describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import { InMemorySession, type InMemorySessionOptions } from "../InMemorySession.js";
import { transcriptRunFacts } from "../sessionTranscriptWindow.js";

/**
 * These drive real runs rather than appending events by hand, because the point
 * is that the daemon knows the turn boundaries it reports. Events written
 * directly into the log would prove only that the window builder works.
 */
describe("InMemorySession transcript window", () => {
    it("reports each real run as one turn with its own outcome", async () => {
        const session = createSession();

        const first = session.submit({ text: "First ask." });
        await expect(session.waitForRun(first.runId)).resolves.toEqual({ status: "completed" });
        const second = session.submit({ text: "Second ask." });
        await expect(session.waitForRun(second.runId)).resolves.toEqual({ status: "completed" });

        const window = session.transcriptWindow();

        expect(window.turns.map((turn) => turn.runId)).toEqual([first.runId, second.runId]);
        expect(window.complete).toBe(true);
        for (const turn of window.turns) {
            expect(turn.outcome).toBe("success");
            expect(turn.startedAt).toBeGreaterThan(0);
            // A finished turn must carry an end, or a client cannot render the
            // elapsed footer it is promised for history.
            expect(turn.endedAt).toBeGreaterThanOrEqual(turn.startedAt);
        }

        await session.beginShutdown();
    });

    it("uses the original run submission as the authoritative turn start", async () => {
        let now = 1_000;
        const session = createSession({ now: () => (now += 10) });

        const submitted = session.submit({ text: "Measure from here." });
        const events = session.events.since(undefined) ?? [];
        const messageSubmitted = events.find(
            (event) => event.type === "message_submitted" && event.data.runId === submitted.runId,
        );
        expect(session.snapshot().activeTurn).toEqual({
            runId: submitted.runId,
            startedAt: messageSubmitted?.createdAt,
        });

        await session.waitForRun(submitted.runId);

        const runStarted = (session.events.since(undefined) ?? []).find(
            (event) => event.type === "run_started" && event.data.runId === submitted.runId,
        );
        const turn = session
            .transcriptWindow()
            .turns.find((candidate) => candidate.runId === submitted.runId);

        expect(messageSubmitted).toBeDefined();
        expect(runStarted).toBeDefined();
        expect(runStarted?.createdAt).toBeGreaterThan(messageSubmitted?.createdAt ?? 0);
        expect(turn?.startedAt).toBe(messageSubmitted?.createdAt);

        await session.beginShutdown();
    });

    it("rebuilds authoritative turn timing from durable events after restart", async () => {
        const session = createSession();
        const submitted = session.submit({ text: "Survive restart." });
        await session.waitForRun(submitted.runId);
        const expected = session
            .transcriptWindow()
            .turns.find((turn) => turn.runId === submitted.runId);

        const restored = createSession({
            events: session.events.since(undefined) ?? [],
            restore: session.state(),
        });

        expect(
            restored.transcriptWindow().turns.find((turn) => turn.runId === submitted.runId),
        ).toEqual(expected);

        await restored.beginShutdown();
        await session.beginShutdown();
    });

    it("says the same thing as the reducer that rebuilds a paged turn", async () => {
        const session = createSession({ retry: true });
        const submitted = session.submit({ text: "Retry once." });
        await session.waitForRun(submitted.runId);

        // The session keeps these facts as it goes; the reducer derives them
        // from the durable log for history a reader pages back into. Where the
        // two disagree, paged history renders differently from what was watched.
        const derived = transcriptRunFacts(session.events.since(undefined) ?? []).get(
            submitted.runId,
        );
        const turn = session
            .transcriptWindow()
            .turns.find((candidate) => candidate.runId === submitted.runId);
        expect(turn?.groups).toEqual(derived?.groups);

        await session.beginShutdown();
    });

    it("persists provider retries as messages inside their transcript turn", async () => {
        const session = createSession({ retry: true });
        const submitted = session.submit({ text: "Retry if needed." });
        await session.waitForRun(submitted.runId);

        const retry = session
            .transcriptWindow()
            .messages.find((message) => message.role === "error");
        expect(retry).toMatchObject({
            blocks: [{ text: "Connection lost", type: "text" }],
            outcome: "retried",
            role: "error",
            attempt: 1,
        });
        expect(
            (session.events.since(undefined) ?? []).some(
                (event) => (event.type as string) === "inference_retry",
            ),
        ).toBe(false);
        expect(
            session.transcriptWindow().turns.find((turn) => turn.runId === submitted.runId)
                ?.messageIds,
        ).toContain(retry?.id);
        expect(session.transcriptWindow().messageGroupId?.[retry?.id ?? ""]).toEqual(
            expect.any(String),
        );
        expect(
            session.state().contextMessages?.find((message) => message.role === "error"),
        ).toEqual(retry);

        await session.beginShutdown();
    });

    it("rebuilds provider retry messages from durable transcript rows after restart", async () => {
        const session = createSession({ retry: true });
        const submitted = session.submit({ text: "Retry and restart." });
        await session.waitForRun(submitted.runId);
        const expected = session
            .transcriptWindow()
            .messages.find((message) => message.role === "error");
        const restored = createSession({
            events: session.events.since(undefined) ?? [],
            restore: session.state(),
        });

        expect(
            restored.transcriptWindow().messages.find((message) => message.role === "error"),
        ).toEqual(expected);

        await restored.beginShutdown();
        await session.beginShutdown();
    });

    it("keeps a turn's messages together under that turn", async () => {
        const session = createSession();

        const submitted = session.submit({ text: "Say hello." });
        await expect(session.waitForRun(submitted.runId)).resolves.toEqual({
            status: "completed",
        });

        const window = session.transcriptWindow();
        const ids = window.turns.flatMap((turn) => turn.messageIds);

        // Every message in the window belongs to exactly one reported turn, so a
        // client never has to guess where a message came from.
        expect(ids).toEqual(window.messages.map((message) => message.id));
        expect(new Set(ids).size).toBe(ids.length);

        await session.beginShutdown();
    });

    it("drops whole turns rather than splitting one when the window is full", async () => {
        const session = createSession();

        const first = session.submit({ text: "First ask." });
        await session.waitForRun(first.runId);
        const second = session.submit({ text: "Second ask." });
        await session.waitForRun(second.runId);

        const window = session.transcriptWindow(1);

        expect(window.turns).toHaveLength(1);
        expect(window.turns[0]?.runId).toBe(second.runId);
        expect(window.complete).toBe(false);
        // The retained turn keeps every message it had; the bound is in turns.
        expect(window.messages.map((message) => message.id)).toEqual(
            window.turns[0]?.messageIds ?? [],
        );

        await session.beginShutdown();
    });

    it("does not grow the window as the conversation gets longer", async () => {
        const session = createSession();

        for (let index = 0; index < 6; index += 1) {
            const submitted = session.submit({ text: `Ask ${index}.` });
            await session.waitForRun(submitted.runId);
        }

        // The cost of attaching has to follow recent activity, not the age of
        // the session, which is the whole reason the window exists.
        const messageTime = vi.spyOn(session.events, "messageCreatedAt");
        const window = session.transcriptWindow(2);
        expect(window.turns).toHaveLength(2);
        expect(messageTime).toHaveBeenCalledTimes(window.messages.length);
        expect(JSON.stringify(window).length).toBeLessThan(
            JSON.stringify(session.transcriptWindow(6)).length,
        );

        await session.beginShutdown();
    });
});

function createSession(
    options: Partial<Pick<InMemorySessionOptions, "events" | "now" | "restore">> & {
        retry?: boolean;
    } = {},
): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/transcript-window",
        name: "Transcript window",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const message = assistantMessage(model.id);
            return createInferenceStream(async function* () {
                yield { type: "start", partial: { ...message, content: [] } };
                if (options.retry === true) {
                    yield { attempt: 1, reason: "Connection lost", type: "retrying" };
                }
                yield { type: "done", reason: "stop", message };
                return message;
            });
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ providerId: provider.id, models: [model] }],
    };
    return new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (options) => createRuntime(options, provider),
        modelCatalog: catalog,
        ...(options.events === undefined ? {} : { events: options.events }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.restore === undefined ? {} : { restore: options.restore }),
        request: {
            cwd: "/tmp/rig-transcript-window",
            modelId: model.id,
            providerId: provider.id,
        },
    });
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
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
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}
