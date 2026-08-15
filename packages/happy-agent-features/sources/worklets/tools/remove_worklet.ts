import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workletNameSchema } from "../Worklet.js";
import type { WorkletsFeature } from "../WorkletsFeature.js";

const removeWorkletInputSchema = Type.Object(
    { name: workletNameSchema },
    { additionalProperties: false },
);

type RemoveWorkletInput = Static<typeof removeWorkletInputSchema>;

export function removeWorkletTool(feature: WorkletsFeature, agentId: string) {
    return defineAgentTool({
        name: "remove_worklet",
        description:
            "Remove one worklet, deleting its icon and every version folder. Its durable Data folder is kept so a later re-install under the same name finds the same state.",
        parameters: removeWorkletInputSchema,
        returnType: Type.Boolean(),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { name }: RemoveWorkletInput) =>
            await feature.remove(ctx, agentId, name),
        toLLM: (removed) => [
            {
                type: "text",
                text: feature.formatRemovalForModel(removed),
            },
        ],
    });
}