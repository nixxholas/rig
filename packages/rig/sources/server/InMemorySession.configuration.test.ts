import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../agent/index.js";
import type { CodingAssistantRuntime } from "../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../runtime/createCodingAssistantAgent.js";
import { NativeProcessManager } from "../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../protocol/index.js";
import { defineModel, defineProvider } from "@slopus/rig-execution";
import { InMemorySession } from "./InMemorySession.js";

/**
 * Configuration a message carries applies when that message's run starts. While a run is already
 * in flight the later messages stay queued, which is the only state where a queued change is
 * visible as pending rather than already applied.
 */
describe("InMemorySession queued configuration", () => {
    it("validates reasoning against a model an earlier queued message has not applied yet", async () => {
        const { session, started, release } = runningSession();

        session.submit({ text: "Start a long run." });
        await started.promise;

        // This one cannot start yet, so its model is still only a pending intent.
        session.submit({ modelId: "test/limited", text: "Switch models." });
        expect(session.state().queuedRuns).toHaveLength(1);

        // "high" suits the model selected right now, so validating against that model instead of
        // the one already queued would wrongly accept this.
        expect(() => session.submit({ effort: "high", text: "Think hard." })).toThrow(
            "Model 'test/limited' does not support 'high' reasoning.",
        );

        release.resolve();
        await session.beginShutdown();
    });

    it("refuses to change the configuration by steering a running response", async () => {
        const { session, started, release } = runningSession();

        session.submit({ text: "Start a long run." });
        await started.promise;

        // Steering reaches the model mid-run, which is exactly where a configuration change must
        // not land. The presence of the field is what is refused, whatever its value.
        for (const change of [
            { effort: "off" },
            { modelId: "test/limited" },
            { serviceTier: "fast" as const },
            // Even a value the session already holds, so the rule cannot depend on current state.
            { modelId: "test/capable" },
        ]) {
            expect(() => session.steer({ ...change, text: "Change it." })).toThrow(
                "can only be changed by submitting a message",
            );
        }

        release.resolve();
        await session.beginShutdown();
    });

    it("does not resend a message that a cross-provider switch already excluded from history", () => {
        const codexModel = defineModel({
            defaultThinkingLevel: "off",
            id: "openai/codex",
            name: "Codex model",
            thinkingLevels: ["off"],
        });
        const claudeModel = defineModel({
            defaultThinkingLevel: "off",
            id: "anthropic/claude",
            name: "Claude model",
            thinkingLevels: ["off"],
        });
        const session = new InMemorySession({
            createEventId: createEventIdFactory(),
            modelCatalog: {
                defaultModelId: codexModel.id,
                defaultProviderId: "codex",
                models: [codexModel, claudeModel],
                providers: [
                    { models: [codexModel], providerId: "codex", providerType: "codex" },
                    { models: [claudeModel], providerId: "claude", providerType: "claude" },
                ],
            },
            request: { cwd: "/tmp/rig-queued-configuration", modelId: codexModel.id },
        });

        session.submit({ modelId: claudeModel.id, providerId: "claude", text: "Only message." });

        // The switch summarized an empty history, so the context is empty rather than absent.
        // Absent would mean "the context is the visible transcript", which still holds this
        // message, and the run would then send it a second time.
        expect(session.snapshot().snapshot.contextMessages).toEqual([]);
    });
});

function testModels() {
    const capableModel = defineModel({
        defaultThinkingLevel: "off",
        id: "test/capable",
        name: "Capable model",
        thinkingLevels: ["off", "high"],
    });
    const limitedModel = defineModel({
        defaultThinkingLevel: "off",
        id: "test/limited",
        name: "Limited model",
        thinkingLevels: ["off"],
    });
    const catalog: ModelCatalog = {
        defaultModelId: capableModel.id,
        defaultProviderId: "test",
        models: [capableModel, limitedModel],
        providers: [{ models: [capableModel, limitedModel], providerId: "test" }],
    };
    return { capableModel, catalog, limitedModel };
}

function runningSession() {
    const started = deferred<void>();
    const release = deferred<void>();
    const { capableModel, catalog, limitedModel } = testModels();
    const provider = defineProvider({
        id: "test",
        models: [capableModel, limitedModel],
        stream() {
            return {
                async *[Symbol.asyncIterator]() {
                    started.resolve();
                    await release.promise;
                    throw new Error("released");
                },
                async result() {
                    throw new Error("released");
                },
            };
        },
    });
    const session = new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (options) => createRuntime(options, provider),
        modelCatalog: catalog,
        request: { cwd: "/tmp/rig-queued-configuration", modelId: capableModel.id },
    });
    return { release, session, started };
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

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T) => void } {
    let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: (value) => resolvePromise(value as T) };
}
