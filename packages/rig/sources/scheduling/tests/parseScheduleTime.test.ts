import { describe, expect, it } from "vitest";

import { MAX_WAIT_MS, parseDateMs, parseDurationMs, parseWaitUntilMs } from "../index.js";

describe("scheduling time parsing", () => {
    it("accepts seconds, hours, days, and readable combinations", () => {
        expect(parseDurationMs({ seconds: 90 })).toBe(90_000);
        expect(parseDurationMs({ hours: 1, days: 0.5 })).toBe(46_800_000);
        expect(parseDurationMs({ duration: "1h 30m" })).toBe(5_400_000);
    });

    it("enforces the durable wait horizon", () => {
        expect(() => parseDurationMs({ days: 2 }, MAX_WAIT_MS)).toThrow("24 hours");
        expect(() => parseWaitUntilMs(1_700_086_401, 1_700_000_000_000)).toThrow("24 hours");
    });

    it("rejects invalid individual duration fields", () => {
        expect(() => parseDurationMs({ hours: -1, seconds: 3_600 })).toThrow("non-negative finite");
        expect(() => parseDurationMs({ seconds: Number.POSITIVE_INFINITY })).toThrow(
            "non-negative finite",
        );
    });

    it("accepts standard dates and Unix timestamps", () => {
        expect(parseDateMs("2026-05-01T12:30:00Z")).toBe(Date.UTC(2026, 4, 1, 12, 30));
        expect(parseDateMs(1_700_000_000)).toBe(1_700_000_000_000);
        expect(parseDateMs(1_700_000_000_123)).toBe(1_700_000_000_123);
    });
});
