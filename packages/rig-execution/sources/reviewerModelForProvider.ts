import type { ExecutorModelProfile } from "@/ExecutorModelProfile.js";
import { modelOpenaiCodexAutoReview, modelOpenaiGpt54 } from "@/models.js";
import type { Model } from "@/types.js";

/**
 * Picks the model that reviews Auto permission decisions.
 *
 * Codex ships a dedicated review model, and Bedrock reviews on GPT-5.4 because it cannot reach
 * that model. Every other provider reviews on the model already running the session, so this
 * returns undefined and the caller keeps the session model.
 */
export function reviewerModelForProvider(
    profiles: readonly ExecutorModelProfile[],
): Model | undefined {
    for (const candidate of [modelOpenaiCodexAutoReview, modelOpenaiGpt54]) {
        const profile = profiles.find(
            (entry) => entry.hidden === true && entry.id === candidate.id,
        );
        if (profile !== undefined) return profile.model;
    }
    return undefined;
}
