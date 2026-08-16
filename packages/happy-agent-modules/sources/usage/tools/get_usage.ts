import { Type, type Static } from "@sinclair/typebox";
import { agentId as contextAgentId, defineAgentTool } from "@slopus/happy-agent-base";

import type { UsageModule } from "../UsageModule.js";
import {
    usageAgentIdSchema,
    usageAggregateQuerySchema,
    usageSummarySchema,
    type UsageSummary,
} from "../Usage.js";

export const getUsageInputSchema = Type.Object(
    {
        aggregate: Type.Optional(Type.Boolean()),
        target: Type.Optional(usageAgentIdSchema),
        cursor: Type.Optional(usageAggregateQuerySchema.properties.cursor),
        maxGroups: Type.Optional(usageAggregateQuerySchema.properties.maxGroups),
    },
    { additionalProperties: false },
);

export type GetUsageInput = Static<typeof getUsageInputSchema>;

/**
 * Read one agent's usage aggregate, or the whole collection when constructed
 * without an agent ID and called from a host-neutral context.
 */
export function getUsageTool(module: UsageModule, agentId?: string) {
    return defineAgentTool({
        name: "get_usage",
        description:
            "Read bounded token and timing usage. Agent tools read their own grouped totals; a host-neutral caller may construct this tool without an agent ID to read one target or the whole collection.",
        parameters: getUsageInputSchema,
        returnType: usageSummarySchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: GetUsageInput): Promise<UsageSummary> => {
            const owner = contextAgentId(ctx);
            if (owner !== undefined) {
                if (agentId !== undefined && agentId !== owner) {
                    throw new Error("Usage can only be read for the current agent.");
                }
                if (input.target !== undefined && input.target !== owner) {
                    throw new Error("Usage can only be read for the current agent.");
                }
            }
            const query = {
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                ...(input.maxGroups === undefined ? {} : { maxGroups: input.maxGroups }),
            };
            /*
             * A host-neutral caller may use the existing `aggregate` flag
             * even when a tool was created from an agent scope.  Agent
             * contexts still remain self-scoped through UsageModule's access
             * boundary.
             */
            if (
                owner === undefined &&
                (input.aggregate === true || input.target !== undefined || agentId === undefined)
            ) {
                return await module.aggregate(ctx, {
                    ...(input.target === undefined ? {} : { agentId: input.target }),
                    ...query,
                });
            }
            if (agentId !== undefined) return await module.read(ctx, agentId, query);
            if (owner !== undefined) return await module.read(ctx, owner, query);
            throw new Error("Usage agent identity is unavailable.");
        },
        toLLM: (summary) => [
            {
                type: "text",
                text: module.formatForModel(summary),
            },
        ],
    });
}
