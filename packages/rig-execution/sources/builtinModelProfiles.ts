import { type ProviderModelCompatibilityType } from "@slopus/rig-providers";

import type { ExecutorModelProfile } from "@/ExecutorModelProfile.js";
import { codex_agent_instructions } from "@/prompts/codex/codex_agent_instructions.js";
import { claude_fable_5_system_prompt } from "@/prompts/claude/claude_fable_5_system_prompt.js";
import { claude_opus_4_8_system_prompt } from "@/prompts/claude/claude_opus_4_8_system_prompt.js";
import { claude_opus_5_system_prompt } from "@/prompts/claude/claude_opus_5_system_prompt.js";
import { claude_sonnet_5_system_prompt } from "@/prompts/claude/claude_sonnet_5_system_prompt.js";
import { grok_4_5_system_prompt } from "@/prompts/grok/grok_4_5_system_prompt.js";
import {
    modelAnthropicFable5,
    modelAnthropicOpus5,
    modelAnthropicOpus48,
    modelAnthropicSonnet5,
    modelOpenaiCodexAutoReview,
    modelOpenaiGpt54,
    modelOpenaiGpt56Luna,
    modelOpenaiGpt56Sol,
    modelOpenaiGpt56Terra,
    modelXaiGrok45,
    modelXaiGrokBuild,
    modelXaiGrokComposer25Fast,
} from "@/models.js";
import type { Model } from "@/types.js";
import { resolveProfileDefaultEffort } from "@/resolveProfileDefaultEffort.js";

export function builtinModelProfiles(
    providerId: string,
    providerType: ProviderModelCompatibilityType,
): readonly ExecutorModelProfile[] {
    if (providerType === "claude") {
        return [
            profile(providerId, providerType, modelAnthropicSonnet5, {
                prompt: claude_sonnet_5_system_prompt,
            }),
            profile(providerId, providerType, modelAnthropicFable5, {
                prompt: claude_fable_5_system_prompt,
            }),
            profile(providerId, providerType, modelAnthropicOpus5, {
                prompt: claude_opus_5_system_prompt,
            }),
            profile(providerId, providerType, modelAnthropicOpus48, {
                prompt: claude_opus_4_8_system_prompt,
            }),
        ];
    }
    if (providerType === "codex") {
        return [
            modelOpenaiGpt56Sol,
            modelOpenaiGpt56Terra,
            modelOpenaiGpt56Luna,
            modelOpenaiCodexAutoReview,
        ].map((candidate) => ({
            ...profile(providerId, providerType, candidate, {
                prompt: codex_agent_instructions,
            }),
            collaborationMode: "namespaced",
            ...(candidate.id === modelOpenaiCodexAutoReview.id ? { hidden: true } : {}),
        }));
    }
    if (providerType === "grok") {
        return [
            profile(providerId, providerType, modelXaiGrokBuild, {
                prompt: grok_4_5_system_prompt,
            }),
            profile(providerId, providerType, modelXaiGrok45, {
                prompt: grok_4_5_system_prompt,
            }),
            profile(providerId, providerType, modelXaiGrokComposer25Fast, {
                prompt: grok_4_5_system_prompt,
            }),
        ];
    }
    if (providerType === "bedrock") {
        return [
            ...builtinModelProfiles(providerId, "claude").map((candidate) => ({
                ...candidate,
                providerType,
            })),
            ...builtinModelProfiles(providerId, "codex")
                // Bedrock has no dedicated review model, so it reviews on full-fledged GPT-5.4.
                .filter((candidate) => candidate.id !== modelOpenaiCodexAutoReview.id)
                .map((candidate) => ({
                    ...candidate,
                    collaborationMode: "direct" as const,
                    providerType,
                })),
            {
                ...profile(providerId, "codex", modelOpenaiGpt54, {
                    prompt: codex_agent_instructions,
                }),
                collaborationMode: "direct" as const,
                hidden: true,
                providerType,
            },
        ];
    }
    return [];
}

function profile(
    providerId: string,
    providerType: Exclude<ProviderModelCompatibilityType, "gym">,
    candidate: Model,
    options: { prompt: string },
): ExecutorModelProfile {
    const defaultEffort = resolveProfileDefaultEffort(candidate.defaultThinkingLevel);
    return {
        ...(candidate.contextWindow === undefined
            ? {}
            : { contextWindow: candidate.contextWindow }),
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
        id: candidate.id,
        model: candidate,
        name: candidate.name,
        providerId,
        providerType,
        serviceTiers: providerType === "codex" ? ["priority"] : [],
        prompt: options.prompt,
    };
}
