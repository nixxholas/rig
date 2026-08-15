import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletDetailPageSchema,
    workletDetailQuerySchema,
    workletNameSchema,
    type WorkletDetailQuery,
} from "../Worklet.js";
import type { WorkletsModule } from "../WorkletsModule.js";

export const getWorkletInputSchema = Type.Object(
    {
        name: workletNameSchema,
        ...workletDetailQuerySchema.properties,
    },
    { additionalProperties: false },
);

export type GetWorkletInput = Static<typeof getWorkletInputSchema>;

export function getWorkletTool(module: WorkletsModule, agentId: string) {
    return defineAgentTool({
        name: "get_worklet",
        description:
            "Read one worklet's status, current version, declared operations, timestamps, and version history. Follow nextCursor for more detail.",
        parameters: getWorkletInputSchema,
        returnType: workletDetailPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { name, ...query }: GetWorkletInput,
        ) => await module.getPage(ctx, agentId, name, query as WorkletDetailQuery),
        toLLM: (page) => [
            {
                type: "text",
                text: module.formatDetailPageForModel(page),
            },
        ],
    });
}