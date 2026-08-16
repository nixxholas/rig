import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingScheduleToolInputSchema,
    schedulingScheduledMessageSchema,
} from "../Scheduling.js";

/**
 * Providers require an object at the root of a tool's parameters, so the absolute time and duration
 * variants stay a closed union and travel as one argument.
 */
const scheduleMessageToolParametersSchema = Type.Object(
    { input: schedulingScheduleToolInputSchema },
    { additionalProperties: false },
);

type ScheduleMessageToolParameters = Static<typeof scheduleMessageToolParametersSchema>;

export function scheduleMessageTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "schedule_message",
        description:
            "Schedule a message to any known agent, including yourself, at a future time. Use ISO 8601, RFC 2822, or a Unix timestamp for at, or use a duration. The host owns durable delivery.",
        parameters: scheduleMessageToolParametersSchema,
        returnType: schedulingScheduledMessageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: ScheduleMessageToolParameters, call) => {
            const { agent_id: targetAgentId, ...scheduleInput } = input;
            return await scheduling.schedule(ctx, agentId, {
                ...scheduleInput,
                id: call.id,
                targetAgentId,
            });
        },
        toLLM: (schedule) => [{ type: "text", text: scheduling.formatScheduleForModel(schedule) }],
    });
}
