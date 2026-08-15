import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingFeature } from "../SchedulingFeature.js";
import {
    schedulingCancelToolInputSchema,
    schedulingScheduledMessageSchema,
    type SchedulingCancelInput,
} from "../Scheduling.js";

export function cancelScheduledMessageTool(scheduling: SchedulingFeature, agentId: string) {
    return defineAgentTool({
        name: "cancel_scheduled_message",
        description:
            "Cancel one of this agent's scheduled messages by ID. Delivery races are settled by the host transaction and cancellation replay is idempotent.",
        parameters: schedulingCancelToolInputSchema,
        returnType: schedulingScheduledMessageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingCancelInput) =>
            await scheduling.cancelSchedule(ctx, agentId, input),
        toLLM: (schedule) => [
            { type: "text", text: scheduling.formatCancellationForModel(schedule) },
        ],
    });
}