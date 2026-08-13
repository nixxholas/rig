import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";

import { claude_fable_5_system_prompt } from "../prompts/claude/claude_fable_5_system_prompt.js";
import { claude_opus_4_8_system_prompt } from "../prompts/claude/claude_opus_4_8_system_prompt.js";
import { claude_opus_5_system_prompt } from "../prompts/claude/claude_opus_5_system_prompt.js";
import { claude_sonnet_5_system_prompt } from "../prompts/claude/claude_sonnet_5_system_prompt.js";
import { codex_agent_instructions } from "../prompts/codex/codex_agent_instructions.js";
import { grok_4_5_system_prompt } from "../prompts/grok/grok_4_5_system_prompt.js";
import { simple_system_prompt } from "../prompts/simple/simple_system_prompt.js";

/** The prompt each model that has one of its own is written for. */
const promptsByModel = new Map<string, string>([
    ["anthropic/opus-5", claude_opus_5_system_prompt],
    ["anthropic/sonnet-5", claude_sonnet_5_system_prompt],
    ["anthropic/fable-5", claude_fable_5_system_prompt],
    ["anthropic/opus-4-8", claude_opus_4_8_system_prompt],
]);

/** What a model family is told when no single model of it was written for. */
const promptsByVendor = {
    claude: claude_opus_5_system_prompt,
    codex: codex_agent_instructions,
    grok: grok_4_5_system_prompt,
} as const;

/** Which vendor a model ID belongs to, which is what its prefix says. */
const vendorsByModelPrefix: readonly (readonly [string, keyof typeof promptsByVendor])[] = [
    ["anthropic/", "claude"],
    ["openai/", "codex"],
    ["xai/", "grok"],
];

/**
 * The prompt a model is written for, with its identity markers still in place.
 *
 * A model with a prompt of its own gets that one. Anything else falls back to the family it
 * belongs to: the model ID names the vendor even when the provider does not — a Claude model
 * served through Bedrock is still a Claude model — so the ID is consulted first, and the kind of
 * provider only when the ID says nothing. A model belonging to no known family gets the simple
 * prompt, so every model is told how to behave rather than none at all.
 */
export function systemPromptForModel(selection: {
    model: string | undefined;
    providerKind?: ProviderModelCompatibilityType | undefined;
}): string {
    const model = selection.model;
    if (model !== undefined) {
        const own = promptsByModel.get(model);
        if (own !== undefined) return own;
        for (const [prefix, vendor] of vendorsByModelPrefix) {
            if (model.startsWith(prefix)) return promptsByVendor[vendor];
        }
    }
    const kind = selection.providerKind;
    if (kind === "claude" || kind === "codex" || kind === "grok") return promptsByVendor[kind];
    return simple_system_prompt;
}
