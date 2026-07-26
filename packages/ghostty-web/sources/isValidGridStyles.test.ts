import { describe, expect, it } from "vitest";

import { isValidGridStyles } from "./isValidGridStyles.js";

describe("semantic grid style validation", () => {
    it("requires bounded, unmodified hyperlink metadata", () => {
        expect(isValidGridStyles([{ hyperlink: null }])).toBe(true);
        expect(isValidGridStyles([{ hyperlink: "javascript:exact()" }])).toBe(true);
        expect(isValidGridStyles([{}])).toBe(false);
        expect(isValidGridStyles([{ hyperlink: "é".repeat(1_025) }])).toBe(false);
    });
});
