import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletLogPageSchema,
    workletLogQuerySchema,
    workletNameSchema,
    type WorkletLogQuery,
} from "../Worklet.js";
import { Type, type Static } from "@sinclair/typebox";
import type { WorkletsModule } from "../WorkletsModule.js";

const readWorkletLogsInputSchema = Type.Object(
    {
        name: workletNameSchema,
        ...workletLogQuerySchema.properties,
    },
    { additionalProperties: false },
);

type ReadWorkletLogsInput = Static<typeof readWorkletLogsInputSchema>;

export function readWorkletLogsTool(module: WorkletsModule, agentId: string) {
    return defineAgentTool({
        name: "read_worklet_logs",
        description:
            "Read a bounded cursor-paged page of worklet logs. Line and aggregate character limits are enforced by the host boundary.",
        parameters: readWorkletLogsInputSchema,
        returnType: workletLogPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (
            ctx,
            { name, ...query }: ReadWorkletLogsInput,
        ) => await module.readLogs(ctx, agentId, name, query as WorkletLogQuery),
        toLLM: (page) => [
            {
                type: "text",
                text: module.formatLogsForModel(page),
            },
        ],
    });
}