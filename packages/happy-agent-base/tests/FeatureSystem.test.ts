import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    currentAgentEnvironment,
    environmentPrompt,
    FeatureSystem,
    claude_fable_5_system_prompt,
    claude_opus_4_8_system_prompt,
    claude_opus_5_system_prompt,
    claude_sonnet_5_system_prompt,
    codex_agent_instructions,
    grok_4_5_system_prompt,
    simple_system_prompt,
    systemPromptForModel,
    withAgentBaseContext,
    withAgentConfig,
} from "../sources/index.js";

const ctx = createRootContext().named("feature-system-test");

describe("FeatureSystem", () => {
    it.each([
        ["anthropic/opus-5", claude_opus_5_system_prompt],
        ["anthropic/opus-4-8", claude_opus_4_8_system_prompt],
        ["anthropic/sonnet-5", claude_sonnet_5_system_prompt],
        ["anthropic/fable-5", claude_fable_5_system_prompt],
        ["openai/gpt-5.6-sol", codex_agent_instructions],
        ["xai/grok-4.5", grok_4_5_system_prompt],
        ["unknown/model", simple_system_prompt],
        [undefined, simple_system_prompt],
    ])("selects the base prompt for %s", (model, expected) => {
        expect(systemPromptForModel(model)).toBe(expected);
    });

    it("injects the selected prompt with Rig's identity", async () => {
        const feature = new FeatureSystem();

        const instructions = feature.instructions(
            withAgentBaseContext(ctx, {
                provider: "claude",
                model: "anthropic/sonnet-5",
            }),
        );

        expect(instructions).toContain("You are Rig, built by Happy");
        expect(instructions).not.toContain("{{identity}}");
    });

    it("states the environment the agent was created for", () => {
        const feature = new FeatureSystem();
        const configured = withAgentConfig(
            withAgentBaseContext(ctx, { provider: "claude", model: "anthropic/sonnet-5" }),
            {
                environment: {
                    osVersion: "25.5.0",
                    platform: "darwin",
                    workingDirectory: "/work",
                    shell: "/bin/zsh",
                },
            },
        );

        const instructions = feature.instructions(configured);

        expect(instructions).toContain(
            [
                "# Environment",
                "- Primary working directory: /work",
                "- Platform: darwin",
                "- Shell: /bin/zsh",
                "- OS version: 25.5.0",
            ].join("\n"),
        );
        // The standing guidance follows the facts.
        expect(instructions).toContain("- Scratch directory: `.context/`");
    });

    it("says nothing about an environment it was not given", () => {
        expect(environmentPrompt(undefined)).toBe("");

        const instructions = new FeatureSystem().instructions(
            withAgentBaseContext(ctx, { provider: "claude", model: "anthropic/sonnet-5" }),
        );
        expect(instructions).not.toContain("# Environment");
        expect(instructions.endsWith("\n")).toBe(false);
    });

    it("reads this process's own environment", () => {
        const environment = currentAgentEnvironment();

        expect(environment.platform).toBe(process.platform);
        expect(environment.workingDirectory).toBe(process.cwd());
        expect(environment.osVersion).not.toBe("");
    });
});
