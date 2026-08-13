import type { Context } from "@steve.kite/stdlib";

import { agentBaseModel } from "../AgentBaseContext.js";
import type { AgentBaseTurnStart } from "../AgentBaseHooks.js";
import type { AgentFeature } from "../AgentFeature.js";
import type { AgentFeatureAction } from "../AgentFeatureAction.js";
import { knownModels, type Model } from "../models.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Room the model needs to finish generating its current response. */
const MAX_OUTPUT_RESERVE = 20_000;
/** Room the compaction itself needs to produce its summary. */
const SUMMARY_SAFETY_RESERVE = 13_000;

/**
 * Compacts the conversation automatically before it outgrows the model's context window. Every
 * turn starts with the real measured size of the context it is about to run on — the complete
 * input the provider received for the last response plus the output it generated, which is where
 * this request starts from. When that size reaches the current model's threshold — its
 * auto-compact window from the curated catalog, minus the output and summary reserves — the
 * feature asks for a compaction, which runs before this turn's first inference. A model absent
 * from the catalog is left alone, since its window is unknown.
 */
export class FeatureAutocompaction implements AgentFeature {
    readonly name = "autocompaction";

    readonly beforeTurn = (
        ctx: Context,
        turn: AgentBaseTurnStart,
    ): readonly AgentFeatureAction[] | undefined => {
        // Nothing has been measured yet — a fresh conversation, or one whose responses all
        // failed before the provider reported a count.
        if (turn.contextTokens === undefined) return undefined;
        const model = findKnownModel(agentBaseModel(ctx));
        if (model === undefined) return undefined;
        return turn.contextTokens < autoCompactThreshold(model) ? undefined : [{ type: "compact" }];
    };
}

function findKnownModel(modelId: string | undefined): Model | undefined {
    if (modelId === undefined) return undefined;
    return knownModels.find((model) => model.id === modelId);
}

function autoCompactThreshold(model: Model): number {
    const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const window = Math.min(contextWindow, model.autoCompactWindow ?? contextWindow);
    return Math.max(0, window - Math.min(window, MAX_OUTPUT_RESERVE) - SUMMARY_SAFETY_RESERVE);
}
