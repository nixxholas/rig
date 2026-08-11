import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trace, type Context as OtelContext, type Span, type Tracer } from "@opentelemetry/api";
import { defineModel, defineProvider } from "@slopus/rig-execution";
import type { RootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import type { ModelCatalog, SessionEvent } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("InMemorySession runtime callback context", () => {
    it("persists background-count changes in a finite worker instead of the runtime caller", async () => {
        const recording = recordingContext();
        const directory = await mkdtemp(join(tmpdir(), "rig-runtime-context-"));
        const backgroundObserved = deferred<void>();
        const releaseObserver = deferred<void>();
        let countListener: ((running: number) => void) | undefined;
        const { catalog, provider } = testProvider();
        const store = await PersistentSessionStore.open(recording.ctx, {
            createRuntime: (options) => {
                const runtime = createRuntime(recording.ctx, options, provider);
                runtime.context.bash.setActiveSessionCountListener = (listener) => {
                    countListener = listener;
                };
                return runtime;
            },
            databasePath: join(directory, "sessions.sqlite"),
            modelCatalog: catalog,
            onSessionEvent: async (event) => {
                if (!isBackgroundCountEvent(event)) return;
                backgroundObserved.resolve(undefined);
                await releaseObserver.promise;
            },
        });
        cleanups.push(async () => {
            releaseObserver.resolve(undefined);
            await store.close(createTestRootContext());
            await rm(directory, { force: true, recursive: true });
        });

        await recording.ctx.span("test.runtime-construction-request", async (requestCtx) => {
            const session = await store.create(requestCtx, {
                cwd: directory,
                modelId: catalog.defaultModelId,
            });
            await session.externalControlContext(requestCtx);
        });
        if (countListener === undefined) throw new Error("Expected a background-count listener.");

        countListener(1);
        await backgroundObserved.promise;

        const request = requiredSpan(recording.calls, "test.runtime-construction-request");
        const worker = requiredSpan(recording.calls, "rig.worker.background-process-count-change");
        expect(request.ended).toBe(true);
        expect(worker.parentSpanId).toBeUndefined();
        expect(worker.ended).toBe(false);
        expect(
            recording.calls.some(
                (call) => call.name.startsWith("rig.sql.") && call.parentSpanId === worker.spanId,
            ),
        ).toBe(true);
        expect(
            recording.calls.some(
                (call) => call.name.startsWith("rig.sql.") && call.parentSpanId === request.spanId,
            ),
        ).toBe(true);

        releaseObserver.resolve(undefined);
        await vi.waitFor(() => expect(worker.ended).toBe(true));
    });
});

function isBackgroundCountEvent(event: SessionEvent): boolean {
    return event.type === "agent_event" && event.data.event.type === "background_processes_changed";
}

function testProvider() {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/runtime-context",
        name: "Runtime context",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            throw new Error("This test only creates a runtime.");
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ models: [model], providerId: provider.id }],
    };
    return { catalog, provider };
}

function createRuntime(
    ctx: RootContext,
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext(ctx.named("agent"), {
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
        executor: provider,
        processManager,
    };
}

interface RecordedSpan {
    ended: boolean;
    name: string;
    parentSpanId?: string;
    spanId: string;
}

function recordingContext(): { calls: RecordedSpan[]; ctx: RootContext } {
    const calls: RecordedSpan[] = [];
    let nextSpanId = 0;
    const tracer = {
        startSpan: (name: string, _options: unknown, parent: OtelContext) => {
            nextSpanId += 1;
            const spanId = nextSpanId.toString(16).padStart(16, "0");
            const parentSpanId = trace.getSpan(parent)?.spanContext().spanId;
            const call: RecordedSpan = {
                ended: false,
                name,
                ...(parentSpanId === undefined ? {} : { parentSpanId }),
                spanId,
            };
            calls.push(call);
            return {
                end: () => {
                    call.ended = true;
                },
                recordException: () => undefined,
                setStatus: () => undefined,
                spanContext: () => ({
                    spanId,
                    traceFlags: 1,
                    traceId: "1".repeat(32),
                }),
            } as unknown as Span;
        },
    } as unknown as Tracer;
    return { calls, ctx: createTestRootContext(tracer) };
}

function requiredSpan(calls: RecordedSpan[], name: string): RecordedSpan {
    const call = calls.find((candidate) => candidate.name === name);
    if (call === undefined) throw new Error(`Expected span ${name}.`);
    return call;
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
} {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
