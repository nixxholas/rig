import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingFeature } from "../SchedulingFeature.js";
import {
    schedulingWaitResultSchema,
    schedulingWaitToolInputSchema,
    type SchedulingWaitToolInput,
} from "../Scheduling.js";

export function waitTool(scheduling: SchedulingFeature, agentId: string) {
    return defineAgentTool({
        name: "wait",
        description:
            "Pause this agent for a bounded duration. The host owns the durable wait; a new message interrupts it and the result reports the time that actually elapsed.",
        parameters: schedulingWaitToolInputSchema,
        returnType: schedulingWaitResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingWaitToolInput) =>
            await scheduling.wait(ctx, agentId, input),
        toLLM: (result) => [{ type: "text", text: scheduling.formatWaitForModel(result) }],
    });
}