import type { SessionEvent } from "@slopus/happy-providers";
import { asyncLock, createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

import {
    AgentBase,
    AgentBaseKV,
    AgentStorage,
    AgentSystemLocal,
    FeatureGoals,
    FeatureSubagents,
    withAgentBaseKV,
    withAgentSystem,
} from "../../sources/index.js";
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

function ownerWithParent(
    parentPersistence: InMemoryPersistence,
    provider: ScriptedProvider,
): { readonly owner: AgentSystemLocal; readonly manager: InMemoryPersistence } {
    const manager = new InMemoryPersistence();
    return {
        manager,
        owner: new AgentSystemLocal({
            features: [],
            storage: new AgentStorage({
                kv: directKV(manager, "agents."),
                persistence: () => parentPersistence,
            }),
            providers: providersOf(provider),
            provider: "scripted",
            models: [],
        }),
    };
}

describe("feature and metadata durability gaps", () => {
    it("recovers a completed child's parent notification after the child process crashes", async () => {
        const parentPersistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([]);
        const { owner } = ownerWithParent(parentPersistence, provider);
        const parent = await owner.create(ctx, "parent", {});

        // The first feature instance observed a complete response, then its process disappeared
        // before afterAgentSettled could durably steer the parent.
        const beforeCrash = new FeatureSubagents("parent/child");
        await beforeCrash.load(withAgentSystem(ctx, owner));
        beforeCrash.onEvent(ctx, { type: "text_start" });
        beforeCrash.onEvent(ctx, { type: "text_delta", delta: "durable child result" });
        beforeCrash.onEvent(ctx, { type: "text_end" });
        beforeCrash.onEvent(ctx, {
            type: "done",
            state: "normal",
            tokens: { input: 1, output: 1 },
        });

        // A new process reconstructs the feature from durable state only.
        const afterCrash = new FeatureSubagents("parent/child");
        await afterCrash.load(withAgentSystem(ctx, owner));
        await afterCrash.afterAgentSettled(ctx);
        await parent.waitForIdle();
        const notifications = parentPersistence.records.filter(
            (record) =>
                record.type === "user" &&
                record.message.content.some(
                    (block) =>
                        block.type === "text" &&
                        block.text.includes("<agent_id>parent/child</agent_id>") &&
                        block.text.includes("durable child result"),
                ),
        );
        await parent.close();

        expect(notifications).toHaveLength(1);
    });

    it("reports the latest error instead of stale text from an earlier inference", async () => {
        const parentPersistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([
            [
                { type: "text_start" },
                { type: "text_delta", delta: "acknowledged" },
                { type: "text_end" },
                { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
            ],
        ]);
        const { owner } = ownerWithParent(parentPersistence, provider);
        const parent = await owner.create(ctx, "parent", {});
        const feature = new FeatureSubagents("parent/child");
        await feature.load(withAgentSystem(ctx, owner));

        feature.onEvent(ctx, { type: "text_start" });
        feature.onEvent(ctx, { type: "text_delta", delta: "stale successful text" });
        feature.onEvent(ctx, { type: "text_end" });
        // A later inference in the same child loop failed without producing a text block.
        feature.onEvent(ctx, {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "latest provider failure",
        });
        await feature.afterAgentSettled(ctx);
        await parent.waitForIdle();

        const notification = parentPersistence.records.find((record) => record.type === "user");
        const text =
            notification?.type === "user"
                ? notification.message.content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text)
                      .join("")
                : "";
        await parent.close();

        expect(text).toContain("<state>error</state>");
        expect(text).toContain("latest provider failure");
        expect(text).not.toContain("stale successful text");
    });

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

    it("publishes one initial goal when two owners load different objectives concurrently", async () => {
        const persistence = new InMemoryPersistence();
        const firstKV = directKV(persistence, "kv.shared.feature.goals.");
        const secondKV = directKV(persistence, "kv.shared.feature.goals.");
        const first = new FeatureGoals({ objective: "objective from owner one" });
        const second = new FeatureGoals({ objective: "objective from owner two" });
        const firstCtx = withAgentBaseKV(ctx, firstKV);
        const secondCtx = withAgentBaseKV(ctx, secondKV);
        const bothRead = deferred();
        const originalReadValues = persistence.readValues.bind(persistence);
        let reads = 0;

        persistence.readValues = async (readCtx, prefix) => {
            if (prefix === "kv.shared.feature.goals.goal" && reads < 2) {
                const snapshot = await originalReadValues(readCtx, prefix);
                reads += 1;
                if (reads === 2) bothRead.resolve();
                await bothRead.promise;
                return snapshot;
            }
            return await originalReadValues(readCtx, prefix);
        };

        await Promise.all([first.tools(firstCtx), second.tools(secondCtx)]);
        const durable = persistence.values.get("kv.shared.feature.goals.goal");

        expect(first.goal).toEqual(durable);
        expect(second.goal).toEqual(durable);
        expect(first.goal).toEqual(second.goal);
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
        const live = new AgentBase(ctx, {
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
        const restarted = new AgentBase(ctx, {
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
        const first = new AgentBase(ctx, {
            id: "writer-collision",
            providers,
            provider: "scripted",
            persistence,
        });
        const second = new AgentBase(ctx, {
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
