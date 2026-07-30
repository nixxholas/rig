import { describe, expect, it } from "vitest";

import { parseGlobalEventCursor } from "./parseGlobalEventCursor.js";

describe("parseGlobalEventCursor", () => {
    it("accepts UUIDv7 cursors and normalizes their case", () => {
        expect(parseGlobalEventCursor("018BCFE5-6800-7FFF-A5AA-0102030405FF")).toBe(
            "018bcfe5-6800-7fff-a5aa-0102030405ff",
        );
    });

    it("rejects the removed stream-position cursor shape", () => {
        expect(parseGlobalEventCursor("missing.0")).toBeUndefined();
    });
});
