import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import type { ProviderUsage } from "@slopus/rig-providers";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type InferenceStream,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";

describe("InMemorySession quota observations", () => {
    it("records what a provider reported about the account while it answered", async () => {
        const model = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/quota-test",
            name: "Quota test",
            thinkingLevels: ["off"],
        });
        const provider = defineProvider({
            id: "claude",
            models: [model],
            stream: () => responseStream(model.id),
        });
        const catalog: ModelCatalog = {
            defaultModelId: model.id,
            defaultProviderId: provider.id,
            models: [model],
            providers: [{ models: [model], providerId: provider.id }],
        };
        const session = new InMemorySession(ctx, {
            createEventId: createEventIdFactory(),
            createRuntime: (options) => {
                // The provider answers the run and reports the account in the
                // same breath, which is exactly what the Claude limiter does.
                options.onAccountUsage?.(observedUsage(42));
                return createRuntime(options, provider);
            },
            modelCatalog: catalog,
            request: {
                cwd: "/tmp/rig-quota-observation",
                modelId: model.id,
                providerId: provider.id,
            },
        });

        const submitted = await session.submit(ctx, { text: "Observe this run." });
        await expect(session.waitForRun(ctx, submitted.runId)).resolves.toEqual({
            status: "completed",
        });

        const observations = session.events
            .all()
            .filter((event) => event.type === "provider_quota_observed");
        expect(observations).toHaveLength(1);
        expect(observations[0]?.data.providerId).toBe("claude");
        expect(observations[0]?.data.quota.windows.fiveHour).toMatchObject({
            status: "available",
            usedPercent: 42,
        });
        // A window the reading left unmeasured is not drawn as an empty bar.
        expect(observations[0]?.data.quota.windows.weekly).toEqual({ status: "unavailable" });
        expect(session.events.latestProviderQuotas().get("claude")?.windows.fiveHour).toMatchObject(
            { usedPercent: 42 },
        );
    });
});

function observedUsage(usedPercent: number): ProviderUsage {
    return {
        providerId: "claude",
        vendor: "claude",
        capturedAt: 1_000,
        planName: "Max",
        exhausted: false,
        windows: {
            fiveHour: {
                durationMs: 5 * 60 * 60 * 1_000,
                resetsAt: 2_000,
                startsAt: null,
                usedPercent,
            },
            weekly: null,
            monthly: null,
        },
        credits: null,
    };
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext(createTestRootContext().named("agent"), {
        cwd: options.cwd,
        processManager,
    });
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
        processManager,
        executor: provider,
    };
}

function responseStream(model: string): InferenceStream {
    const message: AssistantMessage = {
        api: "test",
        content: [{ text: "Observed.", type: "text" }],
        model,
        provider: "claude",
        role: "assistant",
        stopReason: "stop",
        timestamp: 1,
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 10,
            output: 2,
            totalTokens: 12,
        },
    };
    return {
        async *[Symbol.asyncIterator]() {
            yield { partial: message, type: "start" as const };
            yield { message, reason: "stop" as const, type: "done" as const };
        },
        async result() {
            return message;
        },
    };
}
