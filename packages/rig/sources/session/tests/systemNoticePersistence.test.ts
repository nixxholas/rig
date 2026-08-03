import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "@sinclair/typebox";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type InferenceStream,
} from "@slopus/rig-execution";
import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext, type AnyDefinedTool } from "../../agent/index.js";
import { defineTool, type Message } from "../../agent/types.js";
import { NativeProcessManager } from "../../processes/index.js";
import type { ModelCatalog, SystemNoticePayload } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";

describe("persistent standalone system notices", () => {
    it("restores and pages runless notices without inventing transcript turns", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-system-notices-"));
        const databasePath = join(directory, "sessions.sqlite");
        try {
            const initial = new PersistentSessionStore({ databasePath });
            const session = initial.create({ cwd: "/tmp/rig-system-notice-persistence" });
            session.recordSystemNotice(notice("Preparing compute.", "preparing_compute"));
            session.recordSystemNotice(notice("Compute is ready.", "ready"));
            const firstNotice = session.events
                .all()
                .find((event) => event.type === "system_notice");
            expect(firstNotice).toBeDefined();
            const sessionId = session.id;
            initial.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const restored = restoredStore.get(sessionId)!;
                const transcript = restored.transcriptWindow();
                expect(transcript.messages).toEqual([]);
                expect(transcript.turns).toEqual([]);
                expect(
                    transcript.notices?.map((entry) => ({
                        eventId: entry.eventId,
                        structured: entry.message.structured,
                        text: entry.message.blocks[0],
                    })),
                ).toEqual([
                    {
                        eventId: firstNotice!.id,
                        structured: notice("Preparing compute.", "preparing_compute").structured,
                        text: { text: "Preparing compute.", type: "text" },
                    },
                    {
                        eventId: expect.any(String),
                        structured: notice("Compute is ready.", "ready").structured,
                        text: { text: "Compute is ready.", type: "text" },
                    },
                ]);
                expect(
                    restored
                        .transcriptSince(firstNotice!.id)
                        ?.notices?.map((entry) => entry.message.blocks[0]),
                ).toEqual([
                    { text: "Preparing compute.", type: "text" },
                    { text: "Compute is ready.", type: "text" },
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("durably retains only an explicit settling notice after session archival", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-system-notice-archived-"));
        const databasePath = join(directory, "sessions.sqlite");
        try {
            const initial = new PersistentSessionStore({ databasePath });
            const session = initial.create({ cwd: "/tmp/rig-system-notice-archived" });
            session.setArchived(true);
            session.recordSystemNotice(notice("Ignored progress.", "preparing_compute"));
            const terminal: SystemNoticePayload = {
                structured: {
                    computeInstanceId: "compute-1",
                    error: {
                        code: "instance_failed",
                        message: "The compute provider disconnected.",
                        retryable: false,
                        state: "failed",
                    },
                    kind: "compute_preparation",
                    message: "The compute provider disconnected.",
                    phase: "failed",
                    provider: "cloud",
                    state: "failed",
                },
                text: "Compute preparation failed: The compute provider disconnected.",
            };
            session.recordSystemNotice(terminal, { settleArchived: true });
            const sessionId = session.id;
            initial.close();

            const restored = new PersistentSessionStore({ databasePath });
            try {
                expect(restored.get(sessionId)?.transcriptWindow().notices).toMatchObject([
                    {
                        message: {
                            structured: terminal.structured,
                        },
                    },
                ]);
            } finally {
                restored.close();
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("keeps idle notices visible on the oldest SQL page and in a forward range", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-system-notice-mixed-"));
        const databasePath = join(directory, "sessions.sqlite");
        const runtime = immediateRuntimeFixture();
        try {
            const initial = new PersistentSessionStore({
                createRuntime: runtime.createRuntime,
                databasePath,
                modelCatalog: runtime.modelCatalog,
            });
            const session = initial.create({
                cwd: "/tmp/rig-system-notice-mixed",
                modelId: runtime.modelId,
                providerId: runtime.providerId,
            });
            session.recordSystemNotice(notice("Before the first turn.", "preparing_compute"));
            const firstNotice = session.events
                .all()
                .find((event) => event.type === "system_notice")!;
            const first = session.submit({ text: "First real turn." });
            await session.waitForRun(first.runId);
            session.recordSystemNotice(notice("Between turns.", "preparing_compute"));
            const second = session.submit({ text: "Second real turn." });
            await session.waitForRun(second.runId);
            session.recordSystemNotice(notice("After the second turn.", "ready"));
            const sessionId = session.id;
            initial.close();

            const restoredStore = new PersistentSessionStore({
                createRuntime: runtime.createRuntime,
                databasePath,
                modelCatalog: runtime.modelCatalog,
            });
            try {
                const restored = restoredStore.get(sessionId)!;
                const oldest = restored.transcriptPage(1, second.runId);
                expect(oldest?.complete).toBe(true);
                expect(oldest?.messages.map(firstText)).toContain("First real turn.");
                expect(oldest?.notices?.map((entry) => firstText(entry.message))).toEqual([
                    "Before the first turn.",
                    "Between turns.",
                ]);

                const since = restored.transcriptSince(firstNotice.id, 10);
                expect(since?.messages.map(firstText)).toEqual([
                    "First real turn.",
                    "Done.",
                    "Second real turn.",
                    "Done.",
                ]);
                expect(since?.notices?.map((entry) => firstText(entry.message))).toEqual([
                    "Before the first turn.",
                    "Between turns.",
                    "After the second turn.",
                ]);
            } finally {
                restoredStore.close();
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("persists a notice written during an active tool run without changing live state", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-system-notice-active-"));
        const databasePath = join(directory, "sessions.sqlite");
        const runtime = blockingRuntimeFixture();
        try {
            const initial = new PersistentSessionStore({
                createRuntime: runtime.createRuntime,
                databasePath,
                modelCatalog: runtime.modelCatalog,
            });
            const session = initial.create({
                cwd: "/tmp/rig-system-notice-persistent-active",
                modelId: runtime.modelId,
                providerId: runtime.providerId,
                trackUnread: true,
            });
            const submitted = session.submit({ text: "Run the blocking tool." });
            await runtime.toolStarted.promise;
            session.markRead();
            const activityBefore = session.activity();
            const unreadBefore = session.snapshot().unread;

            session.recordSystemNotice(
                notice("Preparing while the tool runs.", "preparing_compute"),
            );

            expect(session.activity()).toEqual(activityBefore);
            expect(session.snapshot().unread).toEqual(unreadBefore);
            expect(
                session.transcriptWindow().notices?.map((entry) => firstText(entry.message)),
            ).toEqual(["Preparing while the tool runs."]);
            runtime.releaseTool.resolve();
            await session.waitForRun(submitted.runId);
            const sessionId = session.id;
            initial.close();

            const restoredStore = new PersistentSessionStore({
                createRuntime: runtime.createRuntime,
                databasePath,
                modelCatalog: runtime.modelCatalog,
            });
            try {
                expect(
                    restoredStore
                        .get(sessionId)
                        ?.transcriptWindow()
                        .notices?.map((entry) => firstText(entry.message)),
                ).toEqual(["Preparing while the tool runs."]);
            } finally {
                restoredStore.close();
            }
        } finally {
            runtime.releaseTool.resolve();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it("rejects a partial-only run as a SQL page anchor", () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const session = store.create({ cwd: "/tmp/rig-system-notice-partial-anchor" });
            store.upsertMessage(session.id, {
                isPartial: true,
                message: {
                    blocks: [{ text: "Still streaming.", type: "text" }],
                    id: "partial-only-message",
                    role: "agent",
                },
                position: 0,
                runId: "partial-only-run",
            });
            expect(store.loadTranscriptPage(session.id, 20, "partial-only-run")).toBeUndefined();
        } finally {
            store.close();
        }
    });

    it("signals when the durable notice slice is truncated", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-system-notice-truncated-"));
        const databasePath = join(directory, "sessions.sqlite");
        try {
            const initial = new PersistentSessionStore({ databasePath });
            const session = initial.create({ cwd: "/tmp/rig-system-notice-truncated" });
            for (let index = 0; index < 51; index += 1) {
                session.recordSystemNotice(
                    notice(`Preparation update ${String(index)}.`, "preparing_compute"),
                );
            }
            const sessionId = session.id;
            initial.close();

            const restoredStore = new PersistentSessionStore({ databasePath });
            try {
                const window = restoredStore.get(sessionId)?.transcriptWindow();
                expect(window?.notices).toHaveLength(50);
                expect(window?.noticesTruncated).toBe(true);
                expect(window?.notices?.[0] && firstText(window.notices[0].message)).toBe(
                    "Preparation update 1.",
                );
            } finally {
                restoredStore.close();
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});

function notice(text: string, phase: "preparing_compute" | "ready"): SystemNoticePayload {
    const preparing = phase === "preparing_compute";
    return {
        structured: {
            computeInstanceId: "compute-1",
            ...(preparing
                ? {
                      elapsedMs: 40_000,
                      error: {
                          code: "preparing_compute" as const,
                          elapsedMs: 40_000,
                          lastProgressAt: 20_000,
                          message: text,
                          retryable: true as const,
                          startedAt: 10_000,
                          state: "unavailable" as const,
                      },
                      lastProgressAt: 20_000,
                      startedAt: 10_000,
                  }
                : {}),
            kind: "compute_preparation",
            message: text,
            phase,
            provider: "cloud",
            state: phase === "ready" ? "ready" : "unavailable",
        },
        text,
    };
}

function firstText(message: Message): string | undefined {
    for (const block of message.blocks) {
        if (block.type === "text") return block.text;
    }
    return undefined;
}

function immediateRuntimeFixture() {
    return runtimeFixture(false);
}

function blockingRuntimeFixture() {
    return runtimeFixture(true);
}

function runtimeFixture(blocking: boolean) {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: blocking ? "test/persistent-blocking" : "test/persistent-immediate",
        name: blocking ? "Persistent blocking" : "Persistent immediate",
        thinkingLevels: ["off"],
    });
    const toolStarted = deferred<void>();
    const releaseTool = deferred<void>();
    let toolExecuting = false;
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const useTool = blocking && !toolExecuting;
            return inferenceStreamFor(
                useTool
                    ? assistantMessage(model.id, [
                          {
                              arguments: {},
                              id: "persistent-call-1",
                              name: "blocking_tool",
                              type: "toolCall",
                          },
                      ])
                    : assistantMessage(model.id, [{ text: "Done.", type: "text" }]),
                useTool ? "toolUse" : "stop",
            );
        },
    });
    const tool = defineTool({
        arguments: Type.Object({}),
        description: "Wait until released.",
        execute: async () => {
            toolExecuting = true;
            toolStarted.resolve();
            await releaseTool.promise;
            return {};
        },
        interruptionMessage: "The tool was interrupted.",
        label: "Blocking tool",
        locks: [],
        name: "blocking_tool",
        returnType: Type.Object({}),
        shouldReviewInAutoMode: () => false,
        toLLM: () => [],
        toUI: () => "Blocking tool",
    });
    const modelCatalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ models: [model], providerId: provider.id }],
    };
    return {
        createRuntime: (options: CreateCodingAssistantAgentOptions) =>
            createRuntime(options, provider, blocking ? [tool] : []),
        modelCatalog,
        modelId: model.id,
        providerId: provider.id,
        releaseTool,
        toolStarted,
    };
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
    tools: readonly AnyDefinedTool[],
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            tools,
        }),
        context,
        cwd: options.cwd,
        executor: provider,
        processManager,
    };
}

function assistantMessage(model: string, content: AssistantMessage["content"]): AssistantMessage {
    return {
        api: "test",
        content,
        model,
        provider: "test",
        role: "assistant",
        stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
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

function inferenceStreamFor(
    message: AssistantMessage,
    reason: "stop" | "toolUse",
): InferenceStream {
    return {
        async *[Symbol.asyncIterator]() {
            yield { partial: message, type: "start" };
            yield { message, reason, type: "done" };
        },
        async result() {
            return message;
        },
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolve = (_value?: T) => {};
    const promise = new Promise<T>((accept) => {
        resolve = (value) => accept(value as T);
    });
    return { promise, resolve };
}
