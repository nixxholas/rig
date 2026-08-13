import { describe, expect, it } from "vitest";

import {
    claude_fable_5_system_prompt,
    claude_opus_4_8_system_prompt,
    claude_opus_5_system_prompt,
    claude_sonnet_5_system_prompt,
    codex_agent_instructions,
    grok_4_5_system_prompt,
    simple_system_prompt,
} from "../sources/index.js";

describe("vendor system prompts", () => {
    it("exports only the copied Rig base prompts", () => {
        expect(codex_agent_instructions).toContain("You are Codex");
        expect(claude_fable_5_system_prompt).toContain("{{identity}}");
        expect(claude_opus_4_8_system_prompt).toContain("{{identity}}");
        expect(claude_opus_5_system_prompt).toContain("{{identity}}");
        expect(claude_sonnet_5_system_prompt).toContain("{{identity}}");
        expect(grok_4_5_system_prompt).toContain("{{identity}}");
        expect(simple_system_prompt).toContain("You are an expert coding assistant.");
        expect(simple_system_prompt.toLowerCase()).not.toContain("pi");
    });
});
