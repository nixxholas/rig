import { describe, expect, it } from "vitest";

import { updateSessionTokenCount } from "./updateSessionTokenCount.js";

describe("updateSessionTokenCount", () => {
    it("tracks current context separately from cumulative provider usage", () => {
        let count = updateSessionTokenCount(undefined, {
            type: "usage",
            contextTokens: 120,
            usage: usage({ cacheRead: 60, input: 40, output: 20 }),
        });
        expect(count).toEqual({ lastContextTokens: 120, totalTokens: 120 });

        count = updateSessionTokenCount(count, {
            type: "usage",
            contextTokens: 150,
            usage: usage({ cacheRead: 100, input: 40, output: 10 }),
        });
        expect(count).toEqual({ lastContextTokens: 150, totalTokens: 270 });

        count = updateSessionTokenCount(count, { type: "compaction", contextTokens: 30 });
        expect(count).toEqual({ lastContextTokens: 30, totalTokens: 270 });

        count = updateSessionTokenCount(count, {
            type: "usage",
            contextTokens: 45,
            usage: usage({ cacheRead: 20, input: 20, output: 5 }),
        });
        expect(count).toEqual({ lastContextTokens: 45, totalTokens: 315 });
    });

    it("keeps counting usage when the current context repeats or shrinks", () => {
        let count = updateSessionTokenCount(undefined, {
            type: "usage",
            contextTokens: 150,
            usage: usage({ cacheRead: 100, input: 40, output: 10 }),
        });
        count = updateSessionTokenCount(count, {
            type: "usage",
            contextTokens: 120,
            usage: usage({ cacheRead: 70, input: 40, output: 10 }),
        });
        count = updateSessionTokenCount(count, {
            type: "usage",
            contextTokens: 130,
            usage: usage({ cacheRead: 80, input: 40, output: 10 }),
        });

        expect(count).toEqual({ lastContextTokens: 130, totalTokens: 400 });
        expect(updateSessionTokenCount(count, { type: "invalidate_context" })).toEqual({
            lastContextTokens: 0,
            totalTokens: 400,
        });
        expect(updateSessionTokenCount(count, { type: "reset" })).toEqual({
            lastContextTokens: 0,
            totalTokens: 0,
        });
    });
});

function usage(values: { cacheRead: number; input: number; output: number }) {
    return {
        ...values,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        totalTokens: values.input + values.output + values.cacheRead,
    };
}
