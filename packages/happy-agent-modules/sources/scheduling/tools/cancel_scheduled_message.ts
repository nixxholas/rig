import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingCancelToolInputSchema,
    schedulingScheduledMessageSchema,
    type SchedulingCancelInput,
} from "../Scheduling.js";

export function cancelScheduledMessageTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "cancel_scheduled_message",
        description:
            "Cancel one of this agent's scheduled messages by ID. Delivery races are settled by the host transaction.",
        parameters: schedulingCancelToolInputSchema,
        returnType: schedulingScheduledMessageSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingCancelInput) =>
            await scheduling.cancelSchedule(ctx, agentId, input),
        toLLM: (schedule) => [
            { type: "text", text: scheduling.formatCancellationForModel(schedule) },
        ],
    });
}