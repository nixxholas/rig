import { describe, expect, it } from "vitest";

import {
    SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION,
    SUBAGENT_MODEL_ARGUMENT_DESCRIPTION,
} from "../subagentSelectionDescriptions.js";

describe("subagent selection descriptions", () => {
    it("lists the allowed effort of every catalog model and marks its default", () => {
        expect(SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION).toContain(
            "- anthropic/sonnet-5 (Sonnet 5): off, low, medium (default), high, xhigh, max, ultra",
        );
        expect(SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION).toContain(
            "- openai/gpt-5.6-sol (GPT-5.6 Sol): off, low, medium (default), high, xhigh, max, ultra",
        );
        expect(SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION).toContain(
            "- openai/gpt-5.6-luna (GPT-5.6 Luna): off, low, medium (default), high, xhigh, max",
        );
        expect(SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION).toContain(
            "- xai/grok-4.5 (Grok 4.5): low, medium, high (default)",
        );
    });

    it("keeps models hidden from the picker out of the enumeration", () => {
        expect(SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION).not.toContain("codex-auto-review");
        expect(SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION).not.toContain("openai/gpt-5.4");
    });

    it("reserves the highest effort levels for work the user asked for", () => {
        expect(SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION).toContain(
            "only use xhigh, max, or ultra when the user asked for that effort",
        );
        expect(SUBAGENT_MODEL_ARGUMENT_DESCRIPTION).toContain(
            "pick a model for this task instead of inheriting one",
        );
    });
});
