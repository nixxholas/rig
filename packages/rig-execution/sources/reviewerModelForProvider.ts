import type { ExecutorModelProfile } from "@/ExecutorModelProfile.js";
import { modelOpenaiCodexAutoReview, modelOpenaiGpt54 } from "@/models.js";
import type { Model } from "@/types.js";

/**
 * Picks the model that reviews Auto permission decisions.
 *
 * Codex ships a dedicated review model, Bedrock reviews OpenAI models on GPT-5.4, and Anthropic
 * Opus/Fable conversations use Sonnet. Otherwise the caller keeps the session model.
 */
export function reviewerModelForProvider(
    profiles: readonly ExecutorModelProfile[],
    activeModelId?: string,
): Model | undefined {
    if (
        activeModelId !== undefined &&
        (activeModelId.startsWith("anthropic/opus-") ||
            activeModelId.startsWith("anthropic/fable-"))
    ) {
        const sonnet = profiles.find((profile) => profile.id === "anthropic/sonnet-5");
        if (sonnet !== undefined) return sonnet.model;
    }
    for (const candidate of [modelOpenaiCodexAutoReview, modelOpenaiGpt54]) {
        const profile = profiles.find(
            (entry) => entry.hidden === true && entry.id === candidate.id,
        );
        if (profile !== undefined) return profile.model;
    }
    return undefined;
}
