import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workletListPageSchema,
    workletListQuerySchema,
    type WorkletListQuery,
} from "../Worklet.js";
import type { WorkletsModule } from "../WorkletsModule.js";

export function listWorkletsTool(module: WorkletsModule, agentId: string) {
    return defineAgentTool({
        name: "list_worklets",
        description:
            "List a bounded page of installed worklets. Follow nextCursor to inspect later entries.",
        parameters: workletListQuerySchema,
        returnType: workletListPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, query: WorkletListQuery) =>
            await module.listPage(ctx, agentId, query),
        toLLM: (page) => [
            {
                type: "text",
                text: module.formatPageForModel(page),
            },
        ],
    });
}