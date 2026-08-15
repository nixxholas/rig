import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletNameSchema,
    workletStatusSchema,
} from "../Worklet.js";
import type { WorkletsModule } from "../WorkletsModule.js";

const statusWorkletInputSchema = Type.Object(
    { name: workletNameSchema },
    { additionalProperties: false },
);

type StatusWorkletInput = Static<typeof statusWorkletInputSchema>;

export function statusWorkletTool(module: WorkletsModule, agentId: string) {
    return defineAgentTool({
        name: "get_worklet_status",
        description: "Read the host runtime status of one installed worklet.",
        parameters: statusWorkletInputSchema,
        returnType: Type.Union([workletStatusSchema, Type.Undefined()]),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { name }: StatusWorkletInput) =>
            await module.status(ctx, agentId, name),
        toLLM: (status) => [
            {
                type: "text",
                text: module.formatStatusForModel(status),
            },
        ],
    });
}

export const getWorkletStatusTool = statusWorkletTool;