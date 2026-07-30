import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import { createInferenceStream } from "@slopus/rig-execution";
import { toLocalDate } from "../../executor/toLocalDate.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type StreamOptions,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";
import { TrackedTaskDrain } from "../../server/TrackedTaskDrain.js";

afterEach(() => {
    vi.useRealTimers();
});

describe("InMemorySession metadata settlement", () => {
    it("titles from the first message immediately, then refines after the first agent response", async () => {
        const harness = createHarness();

        const first = harness.session.submit({ text: "Implement immediate session metadata." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        expect(JSON.stringify(harness.metadataContexts[0])).toContain(
            "Implement immediate session metadata.",
        );
        expect(JSON.stringify(harness.metadataContexts[0])).not.toContain(
            "Final visible response 1.",
        );

        await harness.session.waitForRun(first.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));
        const firstMessageEvent = harness.session.events
            .since(undefined)
            ?.find((event) => event.type === "message_submitted");
        if (firstMessageEvent === undefined) throw new Error("First message event was not stored.");
        expect(harness.runtimeStartDates).toEqual([toLocalDate(firstMessageEvent.createdAt)]);
        expect(JSON.stringify(harness.metadataContexts[1])).toContain("Final visible response 1.");
        await vi.waitFor(() =>
            expect(harness.session.snapshot()).toMatchObject({
                metadataRunId: first.runId,
                recap: "The user implemented delayed session metadata.",
                title: "Delayed session metadata",
                titleStatus: "ready",
            }),
        );
    });

    it("uses the second user message as the one refinement trigger when it arrives first", async () => {
        let releaseAgent: (() => void) | undefined;
        const agentGate = new Promise<void>((resolve) => {
            releaseAgent = resolve;
        });
        const harness = createHarness({ agentGate });

        const first = harness.session.submit({ text: "Start from this message." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        const second = harness.session.submit({ text: "Use this clarification too." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));
        expect(JSON.stringify(harness.metadataContexts[1])).toContain("Start from this message.");
        expect(JSON.stringify(harness.metadataContexts[1])).toContain(
            "Use this clarification too.",
        );
        expect(JSON.stringify(harness.metadataContexts[1])).not.toContain("Final visible response");

        releaseAgent?.();
        await harness.session.waitForRun(first.runId);
        await harness.session.waitForRun(second.runId);
        await Promise.resolve();
        expect(harness.metadataContexts).toHaveLength(2);
        expect(harness.session.snapshot().metadataRunId).toBe(second.runId);
    });

    it("offers the initial chat title to its workspace exactly once", async () => {
        const inheritedTitles: string[] = [];
        const harness = createHarness({ inheritedTitles, workspaceId: "workspace-1" });

        const first = harness.session.submit({ text: "Name this workspace from the chat." });
        await harness.session.waitForRun(first.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        expect(inheritedTitles).toEqual(["Delayed session metadata"]);
    });

    it("serializes refinement behind an in-flight initial title", async () => {
        let releaseStale: (() => void) | undefined;
        const staleReleased = new Promise<void>((resolve) => {
            releaseStale = resolve;
        });
        const harness = createHarness({ staleMetadata: staleReleased });

        const first = harness.session.submit({ text: "Initial request." });
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(1));
        expect(harness.metadataSignals[0]?.aborted).toBe(false);

        const second = harness.session.submit({ text: "A newer request supersedes it." });
        expect(harness.metadataSignals[0]?.aborted).toBe(false);
        releaseStale?.();
        await harness.session.waitForRun(first.runId);
        await harness.session.waitForRun(second.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        expect(harness.session.snapshot()).toMatchObject({
            metadataRunId: second.runId,
            title: "Delayed session metadata",
        });
        expect(harness.session.snapshot().title).not.toBe("Stale generated title");
    });

    it("invalidates stale metadata on rewind and reset", async () => {
        const harness = createHarness();
        const first = harness.session.submit({ text: "Keep this turn." });
        await harness.session.waitForRun(first.runId);
        const second = harness.session.submit({ text: "Remove this turn." });
        await harness.session.waitForRun(second.runId);
        await vi.waitFor(() => expect(harness.metadataContexts).toHaveLength(2));

        const secondMessage = harness.session
            .snapshot()
            .snapshot.messages.find(
                (message) =>
                    message.role === "user" &&
                    message.blocks[0]?.type === "text" &&
                    message.blocks[0].text === "Remove this turn.",
            );
        if (secondMessage === undefined) throw new Error("Second user message was not persisted.");
        harness.session.rewind(secondMessage.id);
        await vi.waitFor(() =>
            expect(harness.session.snapshot()).toMatchObject({
                metadataRunId: first.runId,
                titleStatus: "ready",
            }),
        );

        await harness.session.reset();
        expect(harness.session.snapshot()).toMatchObject({ titleStatus: "idle" });
        expect(harness.session.snapshot()).not.toHaveProperty("metadataRunId");
        expect(harness.session.snapshot()).not.toHaveProperty("metadataUpdatedAt");
        expect(harness.session.snapshot()).not.toHaveProperty("recap");
        await Promise.resolve();
        expect(harness.metadataContexts).toHaveLength(4);
    });

    it("awaits an aborted metadata generation continuation during shutdown", async () => {
        vi.useFakeTimers();
        const taskDrain = new TrackedTaskDrain();
        let releaseAfterAbort: (() => void) | undefined;
        const afterAbort = new Promise<void>((resolve) => {
            releaseAfterAbort = resolve;
        });
        let observedAbort = false;
        const harness = createHarness({
            afterMetadataAbort: afterAbort,
            onMetadataAbort: () => {
                observedAbort = true;
            },
            taskDrain,
        });
        const foreground = harness.session.submit({ text: "Abort in-flight metadata safely." });
        await harness.session.waitForRun(foreground.runId);
        expect(harness.metadataContexts).toHaveLength(1);

        taskDrain.beginClose();
        const shuttingDown = harness.session.beginShutdown();
        const draining = taskDrain.drain();
        await vi.waitFor(() => expect(observedAbort).toBe(true));
        let drained = false;
        void draining.then(() => {
            drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);

        releaseAfterAbort?.();
        await shuttingDown;
        await draining;
        expect(harness.session.snapshot().titleStatus).toBe("idle");
    });
});

function createHarness(
    options: {
        agentGate?: Promise<void>;
        afterMetadataAbort?: Promise<void>;
        onMetadataAbort?: () => void;
        staleMetadata?: Promise<void>;
        taskDrain?: TrackedTaskDrain;
        inheritedTitles?: string[];
        workspaceId?: string;
    } = {},
) {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/session-metadata",
        name: "Session metadata",
        thinkingLevels: ["off"],
    });
    const metadataContexts: Context[] = [];
    const metadataSignals: AbortSignal[] = [];
    let agentResponses = 0;
    let metadataResponses = 0;
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream(_model, context, streamOptions: StreamOptions = {}) {
            if (streamOptions.sessionId?.endsWith(":title")) {
                metadataContexts.push(context);
                if (streamOptions.signal !== undefined) metadataSignals.push(streamOptions.signal);
                metadataResponses += 1;
                return createInferenceStream(async function* () {
                    if (options.afterMetadataAbort !== undefined) {
                        await new Promise<void>((resolve) => {
                            const signal = streamOptions.signal;
                            if (signal?.aborted === true) {
                                resolve();
                                return;
                            }
                            signal?.addEventListener("abort", () => resolve(), { once: true });
                        });
                        options.onMetadataAbort?.();
                        await options.afterMetadataAbort;
                        throw new Error("Metadata generation was cancelled.");
                    }
                    if (metadataResponses === 1 && options.staleMetadata !== undefined) {
                        await options.staleMetadata;
                    }
                    const message = assistantMessage(
                        JSON.stringify(
                            metadataResponses === 1 && options.staleMetadata !== undefined
                                ? {
                                      title: "Stale generated title",
                                      recap: "This stale result must be discarded.",
                                  }
                                : {
                                      title: "Delayed session metadata",
                                      recap: "The user implemented delayed session metadata.",
                                  },
                        ),
                    );
                    yield { type: "start", partial: message };
                    yield { type: "done", reason: "stop", message };
                    return message;
                });
            }
            agentResponses += 1;
            const message = assistantMessage(`Final visible response ${agentResponses}.`);
            return createInferenceStream(async function* () {
                await options.agentGate;
                yield { type: "start", partial: message };
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
    const runtimeStartDates: (string | undefined)[] = [];
    const root = new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (runtimeOptions) => {
            runtimeStartDates.push(runtimeOptions.startDate);
            return createRuntime(runtimeOptions, provider);
        },
        modelCatalog: catalog,
        ...(options.inheritedTitles === undefined
            ? {}
            : {
                  onInitialTitle: ({ title }) => {
                      options.inheritedTitles?.push(title);
                  },
              }),
        projectId: "project-1",
        request: { cwd: "/tmp/rig-metadata-test", modelId: model.id, providerId: provider.id },
        ...(options.taskDrain === undefined ? {} : { taskDrain: options.taskDrain }),
        ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    });
    return {
        metadataContexts,
        metadataSignals,
        runtimeStartDates,
        session: root,
    };
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
            ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
            tools: [],
        }),
        context,
        cwd: options.cwd,
        processManager,
        executor: provider,
    };
}

function assistantMessage(text: string): AssistantMessage {
    return {
        api: "test",
        content: [{ text, type: "text" }],
        model: "test/session-metadata",
        provider: "test",
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
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
