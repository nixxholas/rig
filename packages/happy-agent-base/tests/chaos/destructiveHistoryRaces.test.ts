import type {
    BaseSession,
    SessionCompaction,
    SessionCompactionOptions,
    SessionEvent,
    SessionMessage,
    SessionOptions,
    SessionToolCallBlock,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase, defineAgentTool, type AgentBaseRecord } from "../../sources/index.js";
import { transcriptOf } from "../gym/chaosWorld.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider, ScriptedSession } from "../gym/ScriptedProvider.js";
import { providersOf, system, textTurn, user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-destructive-history-races");

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

async function observedWithin(work: Promise<unknown>, milliseconds = 500): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), milliseconds);
        void work.then(
            () => {
                clearTimeout(timeout);
                resolve(true);
            },
            () => {
                clearTimeout(timeout);
                resolve(true);
            },
        );
    });
}

function call(callId: string, name = "work"): SessionToolCallBlock {
    return {
        type: "tool_call",
        callId,
        name,
        arguments: "{}",
    };
}

function completedCompaction(messages: readonly SessionMessage[]): SessionCompaction {
    return {
        status: "completed",
        preservedMessages: [],
        usage: {
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 12,
        },
        context: { instructions: "", messages },
    };
}

function installCompaction(
    provider: ScriptedProvider,
    result: SessionCompaction,
    started?: Deferred,
    release?: Deferred,
): void {
    const createSession = provider.session.bind(provider);
    provider.session = async (id: string, options: SessionOptions): Promise<BaseSession> => {
        const session = (await createSession(id, options)) as ScriptedSession;
        session.compact = async (
            _compactCtx: Context,
            compactOptions: SessionCompactionOptions,
        ) => {
            session.compactions.push(compactOptions);
            started?.resolve();
            if (release !== undefined) await release.promise;
            return result;
        };
        return session;
    };
}

/**
 * These cases attack destructive history rewrites and response assembly. They deliberately
 * coordinate exact consistency windows rather than depending on scheduler timing.
 */
describe("consistency across destructive history boundaries", () => {
    it("does not let load-time unanswered-call repair erase a concurrently committed suffix", async () => {
        const buried = call("buried-call", "missing");
        const disk = new InMemoryPersistence([
            { type: "user", message: user("old question") },
            { type: "block", block: buried },
            { type: "system", message: system("The last turn failed.") },
            { type: "user", message: user("later question") },
            { type: "block", block: { type: "text", text: "later answer" } },
        ]);
        const repairReachedClear = deferred();
        const releaseRepair = deferred();
        const clearRecords = disk.clearRecords.bind(disk);
        let intercepted = false;
        disk.clearRecords = async (clearCtx) => {
            if (!intercepted) {
                intercepted = true;
                repairReachedClear.resolve();
                await releaseRepair.promise;
            }
            await clearRecords(clearCtx);
        };
        const agent = new AgentBase(ctx, {
            id: "repair-versus-suffix",
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            persistence: disk,
        });

        agent.start();
        expect(await observedWithin(repairReachedClear.promise)).toBe(true);
        const concurrentSuffix: AgentBaseRecord[] = [
            { type: "user", message: user("committed by another owner") },
            { type: "block", block: { type: "text", text: "other owner's answer" } },
        ];
        for (const record of concurrentSuffix) await disk.append(ctx, record);
        releaseRepair.resolve();
        await agent.waitForIdle();
        await agent.close();

        // Repair may replace only the snapshot in which it found the malformed call. Anything
        // committed after that snapshot is an authoritative suffix and must survive the rewrite.
        expect(transcriptOf(disk).slice(-2)).toEqual([
            user("committed by another owner"),
            {
                role: "assistant",
                content: [{ type: "text", text: "other owner's answer" }],
            },
        ]);
    });

    it("does not let sibling tool mappers append after a failed result commit ended the turn", async () => {
        const disk = new InMemoryPersistence();
        const firstResultFailed = deferred();
        const failureRecordPersisted = deferred();
        const slowToolStarted = deferred();
        const releaseSlowTool = deferred();
        const lateToolAppend = deferred();
        const append = disk.append.bind(disk);
        let toolAppendAttempts = 0;
        disk.append = async (appendCtx, record) => {
            if (record.type === "tool") {
                toolAppendAttempts += 1;
                if (toolAppendAttempts === 1) {
                    firstResultFailed.resolve();
                    throw new Error("the first tool result could not commit");
                }
                lateToolAppend.resolve();
            }
            await append(appendCtx, record);
            if (record.type === "system") failureRecordPersisted.resolve();
        };
        const provider = new ScriptedProvider([
            [
                { type: "toolcall_start", callId: "quick-call", name: "quick" },
                { type: "toolcall_end", callId: "quick-call", arguments: "{}" },
                { type: "toolcall_start", callId: "slow-call", name: "slow" },
                { type: "toolcall_end", callId: "slow-call", arguments: "{}" },
                { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
            ],
        ]);
        const agent = new AgentBase(ctx, {
            id: "failed-result-with-live-sibling",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: disk,
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "quick",
                        returnType: Type.Object({ value: Type.String() }),
                        execute: () => Promise.resolve({ value: "quick result" }),
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                    defineAgentTool({
                        name: "slow",
                        returnType: Type.Object({ value: Type.String() }),
                        execute: async () => {
                            slowToolStarted.resolve();
                            await releaseSlowTool.promise;
                            return { value: "slow result" };
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("run both"), { await: true });
        expect(await observedWithin(firstResultFailed.promise)).toBe(true);
        expect(await observedWithin(slowToolStarted.promise)).toBe(true);
        expect(await observedWithin(failureRecordPersisted.promise)).toBe(true);
        const recordsAtTerminalFailure = structuredClone(disk.records);

        releaseSlowTool.resolve();
        const staleMapperTriedToAppend = await observedWithin(lateToolAppend.promise);
        await agent.waitForIdle();
        await agent.close();

        // Once the failed turn has recorded its terminal failure, a mapper from that turn no
        // longer owns the append-only tail. Releasing it must not mutate history behind the
        // failure record or race a later turn.
        expect(staleMapperTriedToAppend).toBe(false);
        expect(disk.records).toEqual(recordsAtTerminalFailure);
    });

    it("does not compact stale memory using a fresh durable record count", async () => {
        const disk = new InMemoryPersistence([
            { type: "user", message: user("history before both owners") },
            { type: "block", block: { type: "text", text: "old answer" } },
        ]);
        const staleOwnerLoaded = deferred();
        const releaseStaleOwner = deferred();
        const compactingProvider = new ScriptedProvider([]);
        installCompaction(
            compactingProvider,
            completedCompaction([system("summary of the old history")]),
        );
        const compactingOwner = new AgentBase(ctx, {
            id: "stale-owner-compaction",
            providers: providersOf(compactingProvider),
            provider: "scripted",
            persistence: disk,
            hooks: {
                beforeTurn: async (): Promise<undefined> => {
                    staleOwnerLoaded.resolve();
                    await releaseStaleOwner.promise;
                    return undefined;
                },
            },
        });
        const writingProvider = new ScriptedProvider([textTurn("committed answer")]);
        const writingOwner = new AgentBase(ctx, {
            id: "stale-owner-compaction",
            providers: providersOf(writingProvider),
            provider: "scripted",
            persistence: disk,
        });

        const compaction = compactingOwner.compact(ctx, { await: true });
        expect(await observedWithin(staleOwnerLoaded.promise)).toBe(true);
        await writingOwner.send(ctx, user("committed before the compaction snapshot count"), {
            await: true,
        });
        await writingOwner.waitForIdle();
        await writingOwner.close();
        releaseStaleOwner.resolve();
        await compaction;
        await compactingOwner.waitForIdle();
        await compactingOwner.close();

        // The destructive boundary and the provider snapshot must describe the same durable
        // prefix. Counting a newer store while summarizing older memory treats the unseen turn
        // as already summarized and erases it.
        expect(transcriptOf(disk)).toEqual([
            system("summary of the old history"),
            user("committed before the compaction snapshot count"),
            {
                role: "assistant",
                content: [{ type: "text", text: "committed answer" }],
            },
        ]);
    });

    it("preserves response-owed provenance for a consumed user suffix kept by compaction", async () => {
        const disk = new InMemoryPersistence([
            { type: "user", message: user("old question") },
            { type: "block", block: { type: "text", text: "old answer" } },
        ]);
        const compactionStarted = deferred();
        const releaseCompaction = deferred();
        const compactingProvider = new ScriptedProvider([]);
        installCompaction(
            compactingProvider,
            completedCompaction([system("summary")]),
            compactionStarted,
            releaseCompaction,
        );
        const compactingOwner = new AgentBase(ctx, {
            id: "compaction-with-owed-suffix",
            providers: providersOf(compactingProvider),
            provider: "scripted",
            persistence: disk,
        });

        const compaction = compactingOwner.compact(ctx, { await: true });
        expect(await observedWithin(compactionStarted.promise)).toBe(true);
        await disk.append(ctx, {
            type: "user",
            message: user("consumed while compaction was running"),
        });
        releaseCompaction.resolve();
        await compaction;
        await compactingOwner.waitForIdle();
        await compactingOwner.close();

        const recoveryProvider = new ScriptedProvider([textTurn("recovered answer")]);
        const recovered = new AgentBase(ctx, {
            id: "compaction-with-owed-suffix",
            providers: providersOf(recoveryProvider),
            provider: "scripted",
            persistence: disk,
        });
        recovered.start();
        await recovered.waitForIdle();
        await recovered.close();

        // The replacement record may end in a user message because it retained a post-snapshot
        // suffix. That message was consumed and still needs an answer; the record's compaction
        // type must not erase that provenance at restart.
        expect(recoveryProvider.sessions.flatMap((session) => session.requests)).toHaveLength(1);
        expect(transcriptOf(disk).at(-1)).toEqual({
            role: "assistant",
            content: [{ type: "text", text: "recovered answer" }],
        });
    });

    it("keeps live and restarted context identical when normal done arrives without text_end", async () => {
        const disk = new InMemoryPersistence();
        disk.values.set("send.00000000000001.000000.seed", {
            message: user("first queued message"),
            options: {},
        });
        disk.values.set("send.00000000000002.000000.seed", {
            message: user("second queued message"),
            options: {},
        });
        disk.values.set("owed", true);
        const liveProvider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "text without an end event" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
            textTurn("second answer"),
        ]);
        const live = new AgentBase(ctx, {
            id: "missing-text-end",
            providers: providersOf(liveProvider),
            provider: "scripted",
            persistence: disk,
        });

        live.start();
        await live.waitForIdle();
        const secondLiveContext = liveProvider.sessions[0]?.requests[1]?.context.messages;
        await live.close();

        const restartedProvider = new ScriptedProvider([textTurn("third answer")]);
        const restarted = new AgentBase(ctx, {
            id: "missing-text-end",
            providers: providersOf(restartedProvider),
            provider: "scripted",
            persistence: disk,
        });
        await restarted.send(ctx, user("message after restart"), { await: true });
        await restarted.waitForIdle();
        const restartedContext = restartedProvider.sessions[0]?.requests[0]?.context.messages;
        await restarted.close();

        // A completed response block is either committed before memory sees it or omitted from
        // both. The next live request must therefore be a durable prefix of the request made
        // after restart; an unterminated block cannot exist only in the former.
        expect(restartedContext).toEqual([
            ...(secondLiveContext ?? []),
            {
                role: "assistant",
                content: [{ type: "text", text: "second answer" }],
            },
            user("message after restart"),
        ]);
    });

    it("rejects duplicate provider tool-call IDs before executing ambiguous calls", async () => {
        const duplicateEvents: SessionEvent[] = [
            { type: "toolcall_start", callId: "duplicate", name: "work" },
            { type: "toolcall_end", callId: "duplicate", arguments: '{"value":"first"}' },
            { type: "toolcall_start", callId: "duplicate", name: "work" },
            { type: "toolcall_end", callId: "duplicate", arguments: '{"value":"second"}' },
            { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
        ];
        const provider = new ScriptedProvider([duplicateEvents, textTurn("ambiguous")]);
        const disk = new InMemoryPersistence();
        const executions: string[] = [];
        const events: SessionEvent[] = [];
        const agent = new AgentBase(ctx, {
            id: "duplicate-provider-call-ids",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: disk,
            hooks: {
                onEvent: (_eventCtx, event) => events.push(event),
            },
            initialState: {
                tools: [
                    defineAgentTool({
                        name: "work",
                        parameters: Type.Object({ value: Type.String() }),
                        returnType: Type.Object({ value: Type.String() }),
                        execute: (_toolCtx, args) => {
                            executions.push(args.value);
                            return Promise.resolve({ value: args.value });
                        },
                        toLLM: (result) => [{ type: "text", text: result.value }],
                    }),
                ],
            },
        });

        await agent.send(ctx, user("produce malformed duplicate calls"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        const internalErrors = events.filter(
            (event) =>
                event.type === "done" && event.state === "error" && event.kind === "internal_error",
        );
        expect(executions).toEqual([]);
        expect(disk.records.filter((record) => record.type === "tool")).toEqual([]);
        expect(internalErrors).toHaveLength(1);
        const internalError = internalErrors[0];
        expect(
            internalError?.type === "done" &&
                internalError.state === "error" &&
                internalError.kind === "internal_error"
                ? internalError.message
                : undefined,
        ).toMatch(/duplicate.*call.*id/i);
    });
});
