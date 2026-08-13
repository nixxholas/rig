import type {
    BaseSession,
    SessionCompaction,
    SessionCompactionOptions,
    SessionOptions,
    SessionRunRequest,
    SessionStream,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { AgentBase, defineAgentTool } from "../../sources/index.js";
import { askedIn, textIn, transcriptOf } from "../gym/chaosWorld.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "../gym/ScriptedProvider.js";
import { providersOf, system, textTurn, user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-ownership-races");

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function settlesWhileBlocked(promise: Promise<void>): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 50);
        void promise.then(() => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

/**
 * These scenarios deliberately overlap ownership boundaries rather than merely adding timing
 * noise inside one owner. Per-instance locks can make one AgentBase perfectly orderly while two
 * live instances, two managers, or a lifecycle operation still disagree about what is durable.
 */
describe("consistency at concurrent ownership boundaries", () => {
    it("keeps every acknowledged queue entry durable when two live owners share one agent ID", async () => {
        const disk = new InMemoryPersistence();
        const provider = new ScriptedProvider([]);
        const providers = providersOf(provider);
        const bothQueueReadsFinished = deferred();
        const releaseLoads = deferred();
        const bothLoadsStarted = deferred();
        const originalReadValues = disk.readValues.bind(disk);
        const originalLoad = disk.load.bind(disk);
        let queueReads = 0;
        let loads = 0;

        // Give both owners the same empty queue snapshot. Their instance-local locks cannot
        // order this read/choose/write sequence against each other.
        disk.readValues = async (readCtx, prefix) => {
            if (prefix === "send." && queueReads < 2) {
                const snapshot = await originalReadValues(readCtx, prefix);
                queueReads += 1;
                if (queueReads === 2) bothQueueReadsFinished.resolve();
                await bothQueueReadsFinished.promise;
                return snapshot;
            }
            return await originalReadValues(readCtx, prefix);
        };
        // Hold both runs immediately after acknowledgement, reproducing the process-loss window
        // in which the durable queue is the only authority for accepted work.
        disk.load = async () => {
            loads += 1;
            if (loads === 2) bothLoadsStarted.resolve();
            await releaseLoads.promise;
            return await originalLoad();
        };

        const first = await AgentBase.create(ctx, {
            id: "shared-agent",
            providers,
            provider: "scripted",
            persistence: disk,
        });
        const second = await AgentBase.create(ctx, {
            id: "shared-agent",
            providers,
            provider: "scripted",
            persistence: disk,
        });
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);

        await Promise.all([
            first.send(ctx, user("accepted by owner one"), { await: true }),
            second.send(ctx, user("accepted by owner two"), { await: true }),
        ]);
        await bothLoadsStarted.promise;
        const durableAtAcknowledgement = [...disk.values.entries()]
            .filter(([key]) => key.startsWith("send."))
            .map(([key, value]) => ({ key, value }));

        clock.mockRestore();
        releaseLoads.resolve();
        await Promise.all([first.waitForIdle(), second.waitForIdle()]);
        await Promise.all([first.close(), second.close()]);

        // Both send promises resolved, so a crash now must be able to recover both messages.
        // A shared key means the later write silently replaced the earlier acknowledgement.
        expect(durableAtAcknowledgement).toHaveLength(2);
        expect(new Set(durableAtAcknowledgement.map(({ key }) => key)).size).toBe(2);
        expect(
            durableAtAcknowledgement
                .map(({ value }) => value)
                .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ).toEqual(
            [
                { message: user("accepted by owner one"), options: {} },
                { message: user("accepted by owner two"), options: {} },
            ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        );
    });

    it("serializes compaction with another live owner's committed inference", async () => {
        const disk = new InMemoryPersistence([
            { type: "user", message: user("history before compaction") },
            { type: "block", block: { type: "text", text: "old answer" } },
        ]);
        const provider = new ScriptedProvider([textTurn("concurrent answer")]);
        const compactionStarted = deferred();
        const releaseCompaction = deferred();
        const originalSession = provider.session.bind(provider);
        const replacement: SessionCompaction = {
            status: "completed",
            preservedMessages: [],
            usage: {
                input: 10,
                output: 2,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 12,
            },
            context: {
                instructions: "",
                messages: [system("summary of the old prefix")],
            },
        };

        provider.session = async (id: string, options: SessionOptions): Promise<BaseSession> => {
            const session = (await originalSession(id, options)) as ScriptedSession;
            if (provider.sessions.length === 1) {
                session.compact = async (
                    _compactCtx: Context,
                    compactOptions: SessionCompactionOptions,
                ) => {
                    session.compactions.push(compactOptions);
                    compactionStarted.resolve();
                    await releaseCompaction.promise;
                    return replacement;
                };
            }
            return session;
        };
        const providers = providersOf(provider);
        const compactingOwner = await AgentBase.create(ctx, {
            id: "shared-agent",
            providers,
            provider: "scripted",
            persistence: disk,
        });
        const writingOwner = await AgentBase.create(ctx, {
            id: "shared-agent",
            providers,
            provider: "scripted",
            persistence: disk,
        });

        const compaction = compactingOwner.compact(ctx, { await: true });
        await compactionStarted.promise;

        await writingOwner.send(ctx, user("committed while compaction was running"), {
            await: true,
        });
        await writingOwner.waitForIdle();
        await writingOwner.close();
        const beforeCompactionCommit = transcriptOf(disk);
        expect(askedIn(beforeCompactionCommit)).toContain("committed while compaction was running");
        expect(textIn(beforeCompactionCommit)).toContain("concurrent answer");

        releaseCompaction.resolve();
        await compaction;
        await compactingOwner.waitForIdle();
        await compactingOwner.close();

        // Compaction may replace only its snapshot. Work committed after that snapshot is a
        // suffix and must survive the destructive clear-and-replace transaction.
        const afterCompactionCommit = transcriptOf(disk);
        expect(afterCompactionCommit).toEqual([
            system("summary of the old prefix"),
            user("committed while compaction was running"),
            {
                role: "assistant",
                content: [{ type: "text", text: "concurrent answer" }],
            },
        ]);
    });

    it("cancels a turn aborted while its pre-inference hook is still running", async () => {
        const provider = new ScriptedProvider([textTurn("this must never be requested")]);
        const beforeTurnStarted = deferred();
        const releaseBeforeTurn = deferred();
        const doneStates: string[] = [];
        const agent = await AgentBase.create(ctx, {
            id: "aborted-before-inference",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            hooks: {
                beforeTurn: async () => {
                    beforeTurnStarted.resolve();
                    await releaseBeforeTurn.promise;
                },
                onEvent: (_eventCtx, event) => {
                    if (event.type === "done") doneStates.push(event.state);
                },
            },
        });

        await agent.send(ctx, user("do not start inference"), { await: true });
        await beforeTurnStarted.promise;
        const aborting = agent.abort(ctx, { await: true });
        releaseBeforeTurn.resolve();
        await aborting;
        await agent.waitForIdle();
        const requests = provider.sessions.flatMap((session) => session.requests);
        await agent.close();

        // Abort owns the whole active turn, including startup before its stream-level abort
        // controller exists. It must not return after allowing that turn to run normally.
        expect({ requests: requests.length, doneStates }).toEqual({
            requests: 0,
            doneStates: ["cancelled"],
        });
    });

    it("settles a compaction requested during inference even when that turn is aborted", async () => {
        const provider = new ScriptedProvider([]);
        const streamStarted = deferred();
        const releaseStream = deferred();
        const originalSession = provider.session.bind(provider);

        provider.session = async (id: string, options: SessionOptions): Promise<BaseSession> => {
            const session = (await originalSession(id, options)) as ScriptedSession;
            session.run = (runCtx: Context, request: SessionRunRequest): SessionStream => {
                session.requestContexts.push(runCtx);
                session.requests.push(request);
                return (async function* () {
                    streamStarted.resolve();
                    await releaseStream.promise;
                    yield {
                        type: "done" as const,
                        state: "normal" as const,
                        tokens: { input: 1, output: 1 },
                    };
                })();
            };
            return session;
        };

        const agent = await AgentBase.create(ctx, {
            id: "aborted-compaction",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });
        await agent.send(ctx, user("hold the response open"), { await: true });
        await streamStarted.promise;

        let compactionSettlement: "pending" | "resolved" | "rejected" = "pending";
        const compaction = agent.compact(ctx, { await: true }).then(
            () => {
                compactionSettlement = "resolved";
            },
            () => {
                compactionSettlement = "rejected";
            },
        );
        const aborting = agent.abort(ctx, { await: true });
        await flushMicrotasks();
        // Let both the current fire-and-forget cleanup and a future awaited cleanup finish. The
        // compaction promise must settle independently of which cleanup policy the stream uses.
        releaseStream.resolve();
        await aborting;
        await agent.waitForIdle();
        await flushMicrotasks();
        const settlementAfterAbort = compactionSettlement;

        await agent.close();
        void compaction;

        // An abort may cancel or finish the requested compaction, but it may not clear the only
        // run request that could ever settle the promise returned to every compact() caller.
        expect(settlementAfterAbort).not.toBe("pending");
    });

    it("awaits provider stream cleanup before starting the next inference", async () => {
        const provider = new ScriptedProvider([]);
        const firstRunStarted = deferred();
        const allowFirstDone = deferred();
        const cleanupStarted = deferred();
        const releaseCleanup = deferred();
        const secondRunStarted = deferred();
        const originalSession = provider.session.bind(provider);
        let cleanupActive = false;
        let secondRunOverlappedCleanup = false;

        provider.session = async (id: string, options: SessionOptions): Promise<BaseSession> => {
            const session = (await originalSession(id, options)) as ScriptedSession;
            let runs = 0;
            session.run = (runCtx: Context, request: SessionRunRequest): SessionStream => {
                session.requestContexts.push(runCtx);
                session.requests.push(request);
                runs += 1;
                if (runs === 1) {
                    let delivered = false;
                    const iterator: AsyncIterator<{
                        readonly type: "done";
                        readonly state: "normal";
                        readonly tokens: { readonly input: number; readonly output: number };
                    }> &
                        AsyncIterable<{
                            readonly type: "done";
                            readonly state: "normal";
                            readonly tokens: {
                                readonly input: number;
                                readonly output: number;
                            };
                        }> = {
                        async next() {
                            if (delivered) return { done: true, value: undefined };
                            firstRunStarted.resolve();
                            await allowFirstDone.promise;
                            delivered = true;
                            return {
                                done: false,
                                value: {
                                    type: "done",
                                    state: "normal",
                                    tokens: { input: 1, output: 1 },
                                },
                            };
                        },
                        async return() {
                            cleanupActive = true;
                            cleanupStarted.resolve();
                            await releaseCleanup.promise;
                            cleanupActive = false;
                            return { done: true, value: undefined };
                        },
                        [Symbol.asyncIterator]() {
                            return this;
                        },
                    };
                    return iterator;
                }

                secondRunOverlappedCleanup = cleanupActive;
                secondRunStarted.resolve();
                return (async function* () {
                    yield* textTurn("second answer");
                })();
            };
            return session;
        };

        const agent = await AgentBase.create(ctx, {
            id: "stream-cleanup",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
        });
        await agent.send(ctx, user("first"), { await: true });
        await firstRunStarted.promise;
        await agent.send(ctx, user("second"), { await: true });
        allowFirstDone.resolve();

        await cleanupStarted.promise;
        const secondRunStartedBeforeCleanupReleased = await settlesWhileBlocked(
            secondRunStarted.promise,
        );
        releaseCleanup.resolve();
        await secondRunStarted.promise;
        await agent.waitForIdle();
        await agent.close();

        // A done event ends the response, not the provider stream's ownership of its stateful
        // session. The next run must wait for iterator.return() to release that ownership.
        expect({
            secondRunStartedBeforeCleanupReleased,
            secondRunOverlappedCleanup,
        }).toEqual({
            secondRunStartedBeforeCleanupReleased: false,
            secondRunOverlappedCleanup: false,
        });
    });

    it("awaits an aborted tool's cleanup before starting the next inference", async () => {
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "cleanup-call", name: "cleanup_tool" },
                {
                    type: "toolcall_end",
                    callId: "cleanup-call",
                    arguments: "{}",
                },
                {
                    type: "done",
                    state: "tool_call",
                    tokens: { input: 1, output: 1 },
                },
            ],
            textTurn("response after cleanup"),
        ]);
        const toolStarted = deferred();
        const cleanupStarted = deferred();
        const releaseCleanup = deferred();
        const cleanupFinished = deferred();
        const secondInferenceStarted = deferred();
        let cleanupActive = false;
        let inferenceCount = 0;
        let secondInferenceOverlappedCleanup = false;
        const agent = await AgentBase.create(ctx, {
            id: "tool-cleanup",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "cleanup_tool",
                        parameters: Type.Object({}),
                        returnType: Type.Object({}),
                        shouldReviewInAutoMode: () => false,
                        execute: async (toolCtx) => {
                            const signal = toolCtx.lifetime;
                            if (signal === undefined) {
                                throw new Error("The tool has no abort lifetime.");
                            }
                            toolStarted.resolve();
                            if (!signal.aborted) {
                                await new Promise<void>((resolve) =>
                                    signal.addEventListener("abort", () => resolve(), {
                                        once: true,
                                    }),
                                );
                            }
                            cleanupActive = true;
                            cleanupStarted.resolve();
                            await releaseCleanup.promise;
                            cleanupActive = false;
                            cleanupFinished.resolve();
                            return {};
                        },
                        toLLM: () => [],
                    }),
                ],
            },
            hooks: {
                beforeInference: () => {
                    inferenceCount += 1;
                    if (inferenceCount === 2) {
                        secondInferenceOverlappedCleanup = cleanupActive;
                        secondInferenceStarted.resolve();
                    }
                },
            },
        });

        await agent.send(ctx, user("start the tool"), { await: true });
        await toolStarted.promise;
        const aborting = agent.abort(ctx, { await: true });
        await cleanupStarted.promise;
        await agent.send(ctx, user("run only after cleanup"), { await: true });
        const secondInferenceStartedBeforeCleanupReleased = await settlesWhileBlocked(
            secondInferenceStarted.promise,
        );

        releaseCleanup.resolve();
        await Promise.all([
            aborting,
            cleanupFinished.promise,
            secondInferenceStarted.promise,
            agent.waitForIdle(),
        ]);
        await agent.close();

        // Recording an aborted result closes the model context, but it does not close the actual
        // tool execution. The session may not advance while that call is still unwinding.
        expect({
            secondInferenceStartedBeforeCleanupReleased,
            secondInferenceOverlappedCleanup,
        }).toEqual({
            secondInferenceStartedBeforeCleanupReleased: false,
            secondInferenceOverlappedCleanup: false,
        });
    });

    it("makes close a barrier for sends admitted before closing began", async () => {
        const disk = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("accepted before close")]);
        const writeStarted = deferred();
        const releaseWrite = deferred();
        const originalWriteValue = disk.writeValue.bind(disk);

        disk.writeValue = async (writeCtx, key, value) => {
            if (key.startsWith("send.")) {
                writeStarted.resolve();
                await releaseWrite.promise;
            }
            await originalWriteValue(writeCtx, key, value);
        };

        const agent = await AgentBase.create(ctx, {
            id: "closing-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: disk,
        });
        const sending = agent.send(ctx, user("already admitted"), { await: true });
        await writeStarted.promise;

        let closeSettled = false;
        const closing = agent.close().then(() => {
            closeSettled = true;
        });
        await flushMicrotasks();
        const closeSettledWhileAdmittedWriteWasBlocked = closeSettled;

        releaseWrite.resolve();
        const sendOutcome = await Promise.allSettled([sending]);
        await closing;
        await agent.waitForIdle();
        const requests = provider.sessions.flatMap((session) => session.requests);
        const allSessionsDestroyed = provider.sessions.every((session) => session.destroyed);

        // Once close resolves, no operation admitted before it may still mutate storage, start
        // inference, or create a provider session that escaped destruction.
        expect({
            closeSettledWhileAdmittedWriteWasBlocked,
            sendStatus: sendOutcome[0]?.status,
            requestsAfterClose: requests.length,
            allSessionsDestroyed,
        }).toEqual({
            closeSettledWhileAdmittedWriteWasBlocked: false,
            sendStatus: "fulfilled",
            requestsAfterClose: 1,
            allSessionsDestroyed: true,
        });
    });
});
