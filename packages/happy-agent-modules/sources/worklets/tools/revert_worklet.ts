import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletNameSchema,
    workletSchema,
    workletToolRevertInputSchema,
    type WorkletToolRevertInput,
} from "../Worklet.js";
import type { WorkletsModule } from "../WorkletsModule.js";

const revertWorkletInputSchema = Type.Object(
    {
        name: workletNameSchema,
        version: workletToolRevertInputSchema.properties.version,
    },
    { additionalProperties: false },
);

type RevertWorkletInput = Static<typeof revertWorkletInputSchema>;

export function revertWorkletTool(module: WorkletsModule, agentId: string) {
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
            return { worklet: await module.revert(ctx, agentId, name, normalized) };
        },
        toLLM: ({ worklet }) => [
            {
                type: "text",
                text: module.formatOperationForModel("Worklet reverted", worklet),
            },
        ],
    });
}