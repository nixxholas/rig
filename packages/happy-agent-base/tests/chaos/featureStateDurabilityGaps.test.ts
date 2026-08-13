import type { SessionEvent } from "@slopus/happy-providers";
import { asyncLock, createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import { AgentBase, AgentBaseKV } from "../../sources/index.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { ScriptedProvider } from "../gym/ScriptedProvider.js";
import { providersOf, user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-feature-state-durability-gaps");

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

function directKV(persistence: InMemoryPersistence, prefix: string): AgentBaseKV {
    const lock = asyncLock({ reentry: "block" });
    return new AgentBaseKV(persistence, prefix, async (operationCtx, work) =>
        lock.runInLock(operationCtx, work),
    );
}

describe("feature and metadata durability gaps", () => {
    it("composes read-modify-write updates made by two live KV owners", async () => {
        const persistence = new InMemoryPersistence();
        persistence.values.set("shared.counter", 0);
        const first = directKV(persistence, "shared.");
        const second = directKV(persistence, "shared.");
        const bothRead = deferred();
        const originalReadValues = persistence.readValues.bind(persistence);
        let reads = 0;

        persistence.readValues = async (readCtx, prefix) => {
            if (prefix === "shared.counter" && reads < 2) {
                const snapshot = await originalReadValues(readCtx, prefix);
                reads += 1;
                if (reads === 2) bothRead.resolve();
                await bothRead.promise;
                return snapshot;
            }
            return await originalReadValues(readCtx, prefix);
        };

        const results = await Promise.all([
            first.update(ctx, "counter", (current) => Number(current) + 1),
            second.update(ctx, "counter", (current) => Number(current) + 1),
        ]);

        expect([...results].sort()).toEqual([1, 2]);
        expect(persistence.values.get("shared.counter")).toBe(2);
    });

    it("does not let failed context-token persistence change only the live agent's decisions", async () => {
        const persistence = new InMemoryPersistence();
        const originalWriteValue = persistence.writeValue.bind(persistence);
        persistence.writeValue = (writeCtx, key, value) =>
            key === "context"
                ? Promise.reject(new Error("context metadata unavailable"))
                : originalWriteValue(writeCtx, key, value);
        const liveStarts: (number | undefined)[] = [];
        const liveProvider = new ScriptedProvider([
            tokenTurn("first answer", 100, 20),
            tokenTurn("second answer", 20, 5),
        ]);
        const live = await AgentBase.create(ctx, {
            id: "token-metadata",
            providers: providersOf(liveProvider),
            provider: "scripted",
            persistence,
            hooks: {
                beforeTurn: (_hookCtx, turn) => {
                    liveStarts.push(turn.contextTokens);
                    return undefined;
                },
            },
        });

        await live.send(ctx, user("first"), { await: true });
        await live.waitForIdle();
        await live.send(ctx, user("second"), { await: true });
        await live.waitForIdle();
        await live.close();

        const restartedStarts: (number | undefined)[] = [];
        const restarted = await AgentBase.create(ctx, {
            id: "token-metadata",
            providers: providersOf(new ScriptedProvider([])),
            provider: "scripted",
            persistence,
            hooks: {
                beforeTurn: (_hookCtx, turn) => {
                    restartedStarts.push(turn.contextTokens);
                    return undefined;
                },
            },
        });
        restarted.start();
        await restarted.waitForIdle();
        await restarted.close();

        const liveDurableKnowledge = liveStarts.filter(
            (value): value is number => value !== undefined,
        );
        const restartedDurableKnowledge = restartedStarts.filter(
            (value): value is number => value !== undefined,
        );
        expect(liveDurableKnowledge).toEqual(restartedDurableKnowledge);
    });

    it("keeps acknowledged queue entries distinct even when writer randomness collides", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([]);
        const providers = providersOf(provider);
        const bothQueueReads = deferred();
        const bothLoads = deferred();
        const releaseLoads = deferred();
        const originalReadValues = persistence.readValues.bind(persistence);
        const originalLoad = persistence.load.bind(persistence);
        let queueReads = 0;
        let loads = 0;

        persistence.readValues = async (readCtx, prefix) => {
            if (prefix === "send." && queueReads < 2) {
                const snapshot = await originalReadValues(readCtx, prefix);
                queueReads += 1;
                if (queueReads === 2) bothQueueReads.resolve();
                await bothQueueReads.promise;
                return snapshot;
            }
            return await originalReadValues(readCtx, prefix);
        };
        persistence.load = async () => {
            loads += 1;
            if (loads === 2) bothLoads.resolve();
            await releaseLoads.promise;
            return await originalLoad();
        };

        const random = vi.spyOn(Math, "random").mockReturnValue(0.25);
        const first = await AgentBase.create(ctx, {
            id: "writer-collision",
            providers,
            provider: "scripted",
            persistence,
        });
        const second = await AgentBase.create(ctx, {
            id: "writer-collision",
            providers,
            provider: "scripted",
            persistence,
        });
        random.mockRestore();
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);

        await Promise.all([
            first.send(ctx, user("first owner"), { await: true }),
            second.send(ctx, user("second owner"), { await: true }),
        ]);
        await bothLoads.promise;
        const pendingAtAcknowledgement = [...persistence.values].filter(([key]) =>
            key.startsWith("send."),
        );

        clock.mockRestore();
        releaseLoads.resolve();
        await Promise.all([first.waitForIdle(), second.waitForIdle()]);
        await Promise.all([first.close(), second.close()]);

        expect(pendingAtAcknowledgement).toHaveLength(2);
        expect(new Set(pendingAtAcknowledgement.map(([key]) => key)).size).toBe(2);
    });
});

function tokenTurn(text: string, input: number, output: number): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input, output } },
    ];
}
