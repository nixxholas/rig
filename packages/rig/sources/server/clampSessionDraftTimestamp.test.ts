import { describe, expect, it } from "vitest";

import { SESSION_DRAFT_MAX_CLOCK_SKEW_MS } from "../protocol/index.js";
import { clampSessionDraftTimestamp } from "./clampSessionDraftTimestamp.js";

const NOW = 1_700_000_000_000;

describe("clampSessionDraftTimestamp", () => {
    it("keeps a stamp from a healthy clock", () => {
        expect(clampSessionDraftTimestamp(NOW - 2_000, NOW)).toBe(NOW - 2_000);
    });

    it("refuses to date a draft in the future", () => {
        expect(clampSessionDraftTimestamp(NOW + 60_000, NOW)).toBe(NOW);
    });

    it("holds a stamp from a clock far in the past inside the skew window", () => {
        expect(clampSessionDraftTimestamp(0, NOW)).toBe(NOW - SESSION_DRAFT_MAX_CLOCK_SKEW_MS);
    });

    it("falls back to the daemon clock for a missing or unusable stamp", () => {
        expect(clampSessionDraftTimestamp(undefined, NOW)).toBe(NOW);
        expect(clampSessionDraftTimestamp(Number.NaN, NOW)).toBe(NOW);
        expect(clampSessionDraftTimestamp(Number.POSITIVE_INFINITY, NOW)).toBe(NOW);
    });
});
