import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingFeature } from "../SchedulingFeature.js";
import {
    schedulingSchedulePageSchema,
    schedulingScheduleToolPageQuerySchema,
    type SchedulingScheduleToolPageQuery,
} from "../Scheduling.js";

export function listScheduledMessagesTool(scheduling: SchedulingFeature, agentId: string) {
    return defineAgentTool({
        name: "list_scheduled_messages",
        description:
            "List this agent's scheduled messages in bounded cursor-paged results. Every returned ID remains complete and actionable.",
        parameters: schedulingScheduleToolPageQuerySchema,
        returnType: schedulingSchedulePageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingScheduleToolPageQuery) =>
            await scheduling.listSchedulePage(ctx, agentId, input),
        toLLM: (page) => [
            { type: "text", text: scheduling.formatSchedulePageForModel(page) },
        ],
    });
}