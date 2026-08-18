import { describe, expect, it } from "vitest";

import { isObjectRooted } from "../../sources/runtime/checkModuleToolParameters.js";

describe("isObjectRooted", () => {
    it("accepts an absent schema and an object schema", () => {
        expect(isObjectRooted(undefined)).toBe(true);
        expect(isObjectRooted({ type: "object" })).toBe(true);
    });

    it("rejects provider-incompatible root schemas", () => {
        expect(isObjectRooted({ type: "array" })).toBe(false);
        expect(isObjectRooted({ anyOf: [{ type: "object" }] })).toBe(false);
        expect(isObjectRooted(null)).toBe(false);
    });
});
