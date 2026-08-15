import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingScheduleToolInputSchema,
    schedulingScheduledMessageSchema,
    type SchedulingScheduleToolInput,
} from "../Scheduling.js";

export function scheduleMessageTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "schedule_message",
        description:
            "Schedule a message to this agent itself at a bounded future time. The host owns durable delivery; this tool never accepts a target agent.",
        parameters: schedulingScheduleToolInputSchema,
        returnType: schedulingScheduledMessageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingScheduleToolInput, call) =>
            await scheduling.schedule(ctx, agentId, {
                ...input,
                id: call.id,
                targetAgentId: agentId,
            }),
        toLLM: (schedule) => [
            { type: "text", text: scheduling.formatScheduleForModel(schedule) },
        ],
    });
}