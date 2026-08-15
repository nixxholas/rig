import { describe, expect, it, vi } from "vitest";

import { sessionOrderKeyForCreation } from "../sessionOrderKeyForCreation.js";

describe("sessionOrderKeyForCreation", () => {
    it("does not give a subagent a position in the ordered session list", () => {
        const createLastOrderKey = vi.fn(() => "a0");

        expect(sessionOrderKeyForCreation("subagent", createLastOrderKey)).toBe("");
        expect(createLastOrderKey).not.toHaveBeenCalled();
    });

    it("creates a list position for a primary session", () => {
        const createLastOrderKey = vi.fn(() => "a0");

        expect(sessionOrderKeyForCreation(undefined, createLastOrderKey)).toBe("a0");
        expect(createLastOrderKey).toHaveBeenCalledOnce();
    });
});
