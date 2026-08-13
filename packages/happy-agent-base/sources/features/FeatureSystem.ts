import type { Context } from "@steve.kite/stdlib";

import { agentBaseModel } from "../AgentBaseContext.js";
import { agentEnvironment, type AgentEnvironment } from "../AgentConfig.js";
import type { AgentFeature } from "../AgentFeature.js";
import {
    claude_fable_5_system_prompt,
    claude_opus_4_8_system_prompt,
    claude_opus_5_system_prompt,
    claude_sonnet_5_system_prompt,
    codex_agent_instructions,
    grok_4_5_system_prompt,
    simple_system_prompt,
} from "./system/index.js";

const DEFAULT_IDENTITY = "You are Rig, built by Happy";

/**
 * Injects the vendor base prompt matching the agent's currently effective model, followed by
 * the environment the agent was created to work in.
 */
export class FeatureSystem implements AgentFeature {
    readonly name = "system";

    readonly instructions = (ctx: Context): string =>
        [
            systemPromptForModel(agentBaseModel(ctx)).replace("{{identity}}", DEFAULT_IDENTITY),
            environmentPrompt(agentEnvironment(ctx)),
        ]
            .filter((part) => part.length > 0)
            .join("\n\n");
}

export function systemPromptForModel(model: string | undefined): string {
    if (model === "anthropic/opus-5") return claude_opus_5_system_prompt;
    if (model === "anthropic/opus-4-8") return claude_opus_4_8_system_prompt;
    if (model === "anthropic/sonnet-5") return claude_sonnet_5_system_prompt;
    if (model === "anthropic/fable-5") return claude_fable_5_system_prompt;
    if (model?.startsWith("openai/") === true) return codex_agent_instructions;
    if (model?.startsWith("xai/") === true) return grok_4_5_system_prompt;
    return simple_system_prompt;
}

/**
 * The environment section of the system prompt, including the guidance about working in it.
 * An agent created without an environment gets no section at all, so the model is never told a
 * working directory or platform that was guessed.
 */
export function environmentPrompt(environment: AgentEnvironment | undefined): string {
    if (environment === undefined) return "";
    return [
        "# Environment",
        `- Primary working directory: ${environment.workingDirectory}`,
        `- Platform: ${environment.platform}`,
        `- Shell: ${environment.shell}`,
        `- OS version: ${environment.osVersion}`,
        "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
        "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.",
    ].join("\n");
}
