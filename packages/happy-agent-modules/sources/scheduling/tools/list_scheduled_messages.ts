import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingSchedulePageSchema,
    schedulingScheduleToolPageQuerySchema,
    type SchedulingScheduleToolPageQuery,
} from "../Scheduling.js";

export function listScheduledMessagesTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "list_scheduled_messages",
        description:
            "List this agent's scheduled messages in bounded cursor-paged results. Every returned ID remains complete and actionable.",
        parameters: schedulingScheduleToolPageQuerySchema,
        returnType: schedulingSchedulePageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingScheduleToolPageQuery, call) =>
            await scheduling.listSchedulePageFromTool(ctx, agentId, input, call),
        toLLM: (page) => [
            { type: "text", text: scheduling.formatSchedulePageForModel(page) },
        ],
    });
}