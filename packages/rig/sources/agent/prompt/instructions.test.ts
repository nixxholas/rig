import { describe, expect, it } from "vitest";

import { createSubagentInstructions } from "./instructions.js";

describe("createSubagentInstructions", () => {
    it("adds the generic parent-handoff overlay", () => {
        const instructions = createSubagentInstructions("Base project instructions.", 1, 2);

        expect(instructions).toContain("Base project instructions.");
        expect(instructions).toContain("You are a subagent working on one delegated step.");
        expect(instructions).toContain("return a concise result to the parent agent");
    });

    it("replaces an existing provider overlay when a nested child changes model", () => {
        const parentInstructions = createSubagentInstructions("Base project instructions.", 1, 3);
        const codexInstructions = createSubagentInstructions(parentInstructions, 2, 3);

        expect(codexInstructions).toContain("Base project instructions.");
        expect(codexInstructions).toContain("You are a subagent working on one delegated step.");
        expect(codexInstructions.match(/You are a subagent working/gu)).toHaveLength(1);
        expect(codexInstructions.match(/at depth/gu)).toHaveLength(1);
    });
});
