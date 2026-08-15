import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingFeature } from "../SchedulingFeature.js";
import {
    schedulingScheduleToolInputSchema,
    schedulingScheduledMessageSchema,
    type SchedulingScheduleToolInput,
} from "../Scheduling.js";

export function scheduleMessageTool(scheduling: SchedulingFeature, agentId: string) {
    return defineAgentTool({
        name: "schedule_message",
        description:
            "Schedule a message to this agent itself at a bounded future time. The host owns durable delivery; this tool never accepts a target agent.",
        parameters: schedulingScheduleToolInputSchema,
        returnType: schedulingScheduledMessageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingScheduleToolInput) =>
            await scheduling.schedule(ctx, agentId, {
                ...input,
                targetAgentId: agentId,
            }),
        toLLM: (schedule) => [
            { type: "text", text: scheduling.formatScheduleForModel(schedule) },
        ],
    });
}