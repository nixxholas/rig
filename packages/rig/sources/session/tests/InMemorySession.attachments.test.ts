import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { AttachmentContext } from "../../tools/attachments/AttachmentContext.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";

describe("InMemorySession final attachments", () => {
    it("atomically commits pending attachments to the last message on success", async () => {
        const session = createSession("stop");
        const attachments = await runtimeContext(session);
        const attachmentContext = attachments.attachments!;
        await attachmentContext.add("/workspace/result.txt", async (id) => ({
            bytes: 4,
            id,
            kind: "file",
            name: "result.txt",
            source: "/workspace/result.txt",
        }));

        const run = await session.submit(ctx, { text: "Show the result." });
        await session.waitForRun(ctx, run.runId);

        const message = session
            .state()
            .messages.findLast(
                (entry) => entry.runId === run.runId && entry.message.role === "agent",
            )?.message;
        expect(message).toMatchObject({
            attachments: [{ kind: "file", name: "result.txt" }],
            role: "agent",
        });
        const finished = session.events
            .since(undefined)
            ?.findLast((event) => event.type === "run_finished" && event.data.runId === run.runId);
        expect(finished?.data).toMatchObject({
            attachmentMessageId: message?.id,
            attachments: [{ kind: "file", name: "result.txt" }],
        });
        await session.beginShutdown(ctx);
    });

    it("discards pending attachments when the turn errors", async () => {
        const session = createSession("error");
        const attachments = await runtimeContext(session);
        const attachmentContext = attachments.attachments!;
        await attachmentContext.add("/workspace/result.txt", async (id) => ({
            bytes: 4,
            id,
            kind: "file",
            name: "result.txt",
            source: "/workspace/result.txt",
        }));

        const run = await session.submit(ctx, { text: "Fail." });
        await session.waitForRun(ctx, run.runId);

        expect(attachmentContext.pending()).toEqual([]);
        expect(
            session
                .state()
                .messages.some(
                    (entry) =>
                        entry.message.role === "agent" &&
                        (entry.message.attachments?.length ?? 0) > 0,
                ),
        ).toBe(false);
        await session.beginShutdown(ctx);
    });
});

function createSession(stopReason: "error" | "stop"): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/attachments",
        name: "Attachments",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const message = assistantMessage(model.id, stopReason);
            return createInferenceStream(async function* () {
                yield { partial: message, type: "start" };
                if (stopReason === "error") {
                    yield { error: message, reason: "error", type: "error" };
                } else {
                    yield { message, reason: "stop", type: "done" };
                }
                return message;
            });
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ models: [model], providerId: provider.id }],
    };
    return new InMemorySession(ctx, {
        createEventId: createEventIdFactory(),
        createRuntime: (options) => {
            const processManager = new NativeProcessManager();
            const context = createNodeAgentContext(createTestRootContext().named("agent"), {
                cwd: options.cwd,
                processManager,
            });
            context.attachments = new AttachmentContext({ idFactory: () => "attachment-1" });
            return {
                agent: new Agent({
                    context,
                    modelId: model.id,
                    printToConsole: false,
                    provider,
                    tools: [],
                }),
                context,
                cwd: options.cwd,
                executor: provider,
                processManager,
            } satisfies CodingAssistantRuntime;
        },
        modelCatalog: catalog,
        request: { cwd: "/tmp/rig-attachments", modelId: model.id, providerId: provider.id },
    });
}

async function runtimeContext(
    session: InMemorySession,
): Promise<Awaited<ReturnType<InMemorySession["externalControlContext"]>>> {
    return await session.externalControlContext(ctx);
}

function assistantMessage(model: string, stopReason: "error" | "stop"): AssistantMessage {
    return {
        api: "test",
        content: stopReason === "stop" ? [{ text: "Done.", type: "text" }] : [],
        ...(stopReason === "error" ? { errorMessage: "Failed." } : {}),
        model,
        provider: "test",
        role: "assistant",
        stopReason,
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
