import type { Context } from "@steve.kite/stdlib";

import type { AgentModel } from "../AgentModel.js";
import { agentSystem } from "../AgentSystemContext.js";
import type { AgentFeature } from "../AgentFeature.js";

/** Adds the owning collection's curated provider/model routes to the system prompt. */
export class FeatureModels implements AgentFeature {
    readonly name = "models";

    #models: readonly AgentModel[] = [];

    async load(ctx: Context): Promise<void> {
        const owner = agentSystem(ctx);
        if (owner === undefined) {
            throw new Error("FeatureModels requires an agent system context.");
        }
        this.#models = owner.models;
    }

    readonly instructions = (): string => {
        if (this.#models.length === 0) return "";
        return [
            "# Available models",
            "You can run subagents with any of these models. When overriding a child's inherited selection, pass the provider and model ID exactly as shown and use one of the listed effort levels:",
            ...this.#models.map((model) => {
                const efforts = model.effortLevels
                    .map((effort) =>
                        effort === model.defaultEffort ? `${effort} (default)` : effort,
                    )
                    .join(", ");
                const tiers =
                    model.serviceTiers === undefined || model.serviceTiers.length === 0
                        ? ""
                        : `; service tiers: ${model.serviceTiers.join(", ")}`;
                return `- ${model.providerId}: ${model.name} (\`${model.id}\`) — effort levels: ${efforts}${tiers}`;
            }),
        ].join("\n");
    };
}
