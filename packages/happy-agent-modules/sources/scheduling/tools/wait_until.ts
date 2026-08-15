import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingWaitResultSchema,
    schedulingWaitUntilToolInputSchema,
    type SchedulingWaitUntilToolInput,
} from "../Scheduling.js";

export function waitUntilTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "wait_until",
        description:
            "Pause this agent until a bounded future ISO 8601 instant. The host owns the durable wait and reports the actual elapsed time if a new message interrupts it.",
        parameters: schedulingWaitUntilToolInputSchema,
        returnType: schedulingWaitResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingWaitUntilToolInput, call) =>
            await scheduling.waitUntilFromTool(ctx, agentId, input, call),
        toLLM: (result) => [{ type: "text", text: scheduling.formatWaitForModel(result) }],
    });
}