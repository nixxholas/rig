import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletNameSchema,
    workletSchema,
    workletToolRevertInputSchema,
    type WorkletToolRevertInput,
} from "../Worklet.js";
import type { WorkletsFeature } from "../WorkletsFeature.js";

const revertWorkletInputSchema = Type.Object(
    {
        name: workletNameSchema,
        version: workletToolRevertInputSchema.properties.version,
    },
    { additionalProperties: false },
);

type RevertWorkletInput = Static<typeof revertWorkletInputSchema>;

export function revertWorkletTool(feature: WorkletsFeature, agentId: string) {
    return defineAgentTool({
        name: "revert_worklet",
        description: "Make an earlier existing worklet version current without deleting history.",
        parameters: revertWorkletInputSchema,
        returnType: Type.Object({ worklet: workletSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: RevertWorkletInput) => {
            const { name, version } = input;
            const normalized: WorkletToolRevertInput = { version };
            return { worklet: await feature.revert(ctx, agentId, name, normalized) };
        },
        toLLM: ({ worklet }) => [
            {
                type: "text",
                text: feature.formatOperationForModel("Worklet reverted", worklet),
            },
        ],
    });
}