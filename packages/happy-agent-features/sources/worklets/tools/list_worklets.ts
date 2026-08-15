import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletListPageSchema,
    workletListQuerySchema,
    type WorkletListQuery,
} from "../Worklet.js";
import type { WorkletsFeature } from "../WorkletsFeature.js";

export function listWorkletsTool(feature: WorkletsFeature, agentId: string) {
    return defineAgentTool({
        name: "list_worklets",
        description:
            "List a bounded page of installed worklets. Follow nextCursor to inspect later entries.",
        parameters: workletListQuerySchema,
        returnType: workletListPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: WorkletListQuery) =>
            await feature.listPage(ctx, agentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: feature.formatPageForModel(page),
            },
        ],
    });
}