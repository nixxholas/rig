import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletChangeDescriptionSchema,
    workletNameSchema,
    workletSchema,
    workletSourceRefSchema,
    type WorkletToolUpdateInput,
} from "../Worklet.js";
import type { WorkletsModule } from "../WorkletsModule.js";

const updateWorkletInputSchema = Type.Object(
    {
        name: workletNameSchema,
        sourceRef: workletSourceRefSchema,
        changeDescription: workletChangeDescriptionSchema,
    },
    { additionalProperties: false },
);

type UpdateWorkletInput = Static<typeof updateWorkletInputSchema>;

export function updateWorkletTool(module: WorkletsModule, agentId: string) {
    return defineAgentTool({
        name: "update_worklet",
        description:
            "Install a new version of a worklet from an absolute path to its source folder. Rig copies it into the next version folder; the Data folder and older versions are kept, and a change description is required.",
        parameters: updateWorkletInputSchema,
        returnType: Type.Object({ worklet: workletSchema }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: UpdateWorkletInput) => {
            const { name, ...rest } = input;
            const normalized: WorkletToolUpdateInput = rest;
            return { worklet: await module.update(ctx, agentId, name, normalized) };
        },
        toLLM: ({ worklet }) => [
            {
                type: "text",
                text: module.formatOperationForModel("Worklet updated", worklet),
            },
        ],
    });
}