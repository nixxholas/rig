import { describe, expect, it } from "vitest";

import {
    ChaosFailure,
    ChaosTraceRecorder,
    DeterministicRandom,
    createPublicStateBarrier,
    ddminChaosSchedule,
    digestPublicModel,
    generateChaosSchedule,
    namedChaosSeeds,
    runChaosSchedule,
    sanitizeTraceValue,
    selectChaosSeeds,
    simplifyChaosSchedule,
    waitForPublicEvent,
    type ChaosActionKind,
} from "../sources/index.js";

describe("API chaos foundation", () => {
    it("generates the same values and forks for the same seed", () => {
        const first = new DeterministicRandom("catalog-C000");
        const second = new DeterministicRandom("catalog-C000");
        expect(Array.from({ length: 8 }, () => first.nextUint32())).toEqual(
            Array.from({ length: 8 }, () => second.nextUint32()),
        );
        expect(new DeterministicRandom(7).fork("actions").nextUint32()).toBe(
            new DeterministicRandom(7).fork("actions").nextUint32(),
        );
    });

    it("selects exact, numeric, and ranged names without changing seed order", () => {
        const seeds = namedChaosSeeds("C", 6);
        expect(selectChaosSeeds(seeds, "C001,C004").map((seed) => seed.label)).toEqual([
            "C001",
            "C004",
        ]);
        expect(selectChaosSeeds(seeds, "2-4").map((seed) => seed.label)).toEqual([
            "C002",
            "C003",
            "C004",
        ]);
        expect(() => selectChaosSeeds(seeds, "missing")).toThrow(/API_CHAOS_SEED/);
    });

    it("generates and replays an identical action schedule", () => {
        type Action = {
            readonly kind: string;
            readonly index: number;
            readonly value: number | boolean;
        };
        const kinds: readonly ChaosActionKind<Action>[] = [
            {
                name: "read",
                create: (random: DeterministicRandom, index: number) => ({
                    kind: "read",
                    index,
                    value: random.int(0, 100),
                }),
            },
            {
                name: "write",
                create: (random: DeterministicRandom, index: number) => ({
                    kind: "write",
                    index,
                    value: random.bool(),
                }),
            },
        ] as const;
        const first = generateChaosSchedule({ label: "C000", value: 0 }, 20, kinds);
        const second = generateChaosSchedule({ label: "C000", value: 0 }, 20, kinds);
        expect(first).toEqual(second);
        expect(first.slice(0, 5)).toEqual(second.slice(0, 5));
    });

    it("redacts and bounds trace values while retaining a stable digest", () => {
        const cyclic: { token: string; path: string; values: unknown[] } = {
            token: "secret-token",
            path: "/Users/steve/private",
            values: [],
        };
        cyclic.values.push("x".repeat(800), cyclic);
        const sanitized = sanitizeTraceValue(cyclic);
        expect(sanitized).toMatchObject({
            path: "[redacted]",
            token: "[redacted]",
            values: ["x".repeat(488) + "…[800 chars]", "[circular]"],
        });
        expect(digestPublicModel({ b: 2, a: 1 })).toBe(digestPublicModel({ a: 1, b: 2 }));
    });

    it("records successful public observations and reports the first failed prefix", async () => {
        const trace = new ChaosTraceRecorder({ maxEntries: 4 });
        await expect(
            runChaosSchedule({
                suite: "catalog",
                seed: "C000",
                schedule: [{ kind: "ok" }, { kind: "bad" }, { kind: "never" }],
                trace,
                apply: async (action, step) => {
                    if (action.kind === "bad") throw new Error(`bad step ${String(step)}`);
                    return { state: { step } };
                },
            }),
        ).rejects.toSatisfy((error: unknown) => {
            if (!(error instanceof ChaosFailure)) return false;
            expect(error.message).toContain("suite=catalog seed=C000 step=1");
            expect(error.message).toContain("modelDigest=");
            expect(error.context.trace?.entries).toHaveLength(2);
            return true;
        });
    });

    it("runs deterministic ddmin and action reductions", async () => {
        const schedule = [1, 2, 3, 4, 5, 6];
        const fails = async (candidate: readonly number[]): Promise<boolean> =>
            candidate.includes(5) && candidate.includes(6);
        await expect(ddminChaosSchedule(schedule, fails)).resolves.toEqual([5, 6]);
        await expect(
            simplifyChaosSchedule([1, 5, 6], fails, [
                { name: "decrement", apply: (value) => (value > 1 ? [value - 1] : []) },
            ]),
        ).resolves.toEqual([5, 6]);
    });

    it("waits on public snapshots and event lists rather than private state", async () => {
        let value = 0;
        const barrier = createPublicStateBarrier(async () => ({
            state: value,
            cursor: String(value),
        }));
        const statePromise = barrier.waitFor((snapshot) => snapshot.state === 2, "value 2", {
            timeoutMs: 1_000,
            pollMs: 1,
        });
        value = 2;
        await expect(statePromise).resolves.toMatchObject({ state: 2, cursor: "2" });

        let events: readonly string[] = [];
        const eventPromise = waitForPublicEvent(
            async () => events,
            (event) => event === "created",
            { timeoutMs: 1_000, pollMs: 1 },
        );
        events = ["created"];
        await expect(eventPromise).resolves.toBe("created");
    });
});
