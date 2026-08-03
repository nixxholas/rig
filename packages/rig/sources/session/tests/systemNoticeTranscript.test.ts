import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext, type AnyDefinedTool } from "../../agent/index.js";
import { defineTool } from "../../agent/types.js";
import { NativeProcessManager } from "../../processes/index.js";
import {
    createEventIdFactory,
    type ModelCatalog,
    type SystemNoticePayload,
} from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type InferenceStream,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";

const stores: InMemorySessionStore[] = [];

afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
});

function computeNotice(phase: "preparing_compute" | "ready"): SystemNoticePayload {
    const ready = phase === "ready";
    return {
        structured: {
            computeInstanceId: "compute-1",
            kind: "compute_preparation",
            message: ready ? "Compute is ready." : "Preparing the compute instance.",
            phase,
            provider: "cloud",
            state: ready ? "ready" : "provisioning",
        },
        text: ready ? "Compute is ready." : "Preparing compute.",
    };
}

describe("standalone system notice transcript rows", () => {
    it("keeps an idle notice before the first turn in the oldest in-memory window", () => {
        const store = new InMemorySessionStore();
        stores.push(store);
        const session = store.create({ cwd: "/tmp/rig-system-notice-oldest" });
        session.recordSystemNotice(computeNotice("preparing_compute"));

        session.submit({ text: "Start the first real turn." });

        expect(session.transcriptWindow().notices?.map((entry) => entry.message.blocks[0])).toEqual(
            [{ text: "Preparing compute.", type: "text" }],
        );
    });

    it("leaves a mid-tool run's activity, pending input, and unread state untouched", async () => {
        const toolStarted = deferred<void>();
        const releaseTool = deferred<void>();
        const session = createToolSession(toolStarted, releaseTool);
        session.submit({ text: "Run the tool." });
        await toolStarted.promise;

        const question = {
            requestId: "question-1",
            questions: [
                {
                    header: "Choice",
                    id: "choice",
                    multiSelect: false,
                    options: [
                        { description: "Choose one.", label: "One" },
                        { description: "Choose two.", label: "Two" },
                    ],
                    question: "Which choice?",
                },
            ],
        };
        const pendingAnswer = session.requestUserInput(question);
        expect(session.markRead()).toBe(true);
        const activityBefore = session.activity();
        expect(activityBefore).toMatchObject({
            kind: "awaiting_input",
            pendingInputRequestIds: [question.requestId],
            toolCalls: [{ toolCallId: expect.any(String), toolName: "blocking_tool" }],
        });
        const pendingBefore = session.snapshot().pendingUserInputs;
        const unreadBefore = session.snapshot().unread;
        const runFinishedBefore = session.events
            .all()
            .filter((event) => event.type === "run_finished").length;

        session.recordSystemNotice(computeNotice("preparing_compute"));

        expect(session.activity()).toEqual(activityBefore);
        expect(session.snapshot().pendingUserInputs).toEqual(pendingBefore);
        expect(session.snapshot().unread).toEqual(unreadBefore);
        expect(session.events.all().filter((event) => event.type === "run_finished")).toHaveLength(
            runFinishedBefore,
        );
        const notice = session.events.all().find((event) => event.type === "system_notice");
        expect(notice).toBeDefined();
        const toolStartIndex = session.events
            .all()
            .findIndex(
                (event) =>
                    event.type === "agent_event" &&
                    event.data.event.type === "tool_execution_start",
            );
        expect(session.events.all().indexOf(notice!)).toBeGreaterThan(toolStartIndex);

        const transcript = session.transcriptWindow(20);
        expect(transcript.notices).toEqual([
            {
                createdAt: notice!.createdAt,
                eventId: notice!.id,
                message: notice!.data.message,
            },
        ]);
        expect(
            transcript.turns.some((turn) => turn.messageIds.includes(notice!.data.message.id)),
        ).toBe(false);

        session.answerUserInput(question.requestId, { answers: { choice: ["One"] } });
        await pendingAnswer;
        releaseTool.resolve();
        await session.beginShutdown();
    });

    it("bounds notices separately without evicting real conversation turns", () => {
        const store = new InMemorySessionStore();
        stores.push(store);
        const session = store.create({ cwd: "/tmp/rig-system-notice-budget" });

        for (let turn = 0; turn < 25; turn += 1) {
            session.submit({ text: `Real turn ${String(turn)}.` });
            for (let notice = 0; notice < 5; notice += 1) {
                session.recordSystemNotice(computeNotice("preparing_compute"));
            }
        }

        const bootstrap = session.transcriptWindow(20);
        expect(bootstrap.turns).toHaveLength(20);
        expect(bootstrap.messages).toHaveLength(20);
        expect(bootstrap.notices).toHaveLength(50);
        expect(bootstrap.noticesTruncated).toBe(true);
        expect(bootstrap.messages[0]?.blocks).toEqual([{ text: "Real turn 5.", type: "text" }]);
    });
});

function createToolSession(
    toolStarted: ReturnType<typeof deferred<void>>,
    releaseTool: ReturnType<typeof deferred<void>>,
): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/system-notice",
        name: "System notice",
        thinkingLevels: ["off"],
    });
    let toolExecuting = false;
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const reason = toolExecuting ? ("stop" as const) : ("toolUse" as const);
            const message = !toolExecuting
                ? assistantMessage(model.id, [
                      {
                          arguments: {},
                          id: "call-1",
                          name: "blocking_tool",
                          type: "toolCall",
                      },
                  ])
                : assistantMessage(model.id, [{ text: "Finished.", type: "text" }]);
            return inferenceStreamFor(message, reason);
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
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ models: [model], providerId: provider.id }],
    };
    return new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (options) => createRuntime(options, provider, [tool]),
        id: "system-notice-session",
        metadata: {
            depth: 0,
            description: "System notice test",
            rootSessionId: "system-notice-session",
            type: "primary",
        },
        modelCatalog: catalog,
        request: {
            cwd: "/tmp/rig-system-notice-active",
            modelId: model.id,
            providerId: provider.id,
            trackUnread: true,
        },
    });
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
