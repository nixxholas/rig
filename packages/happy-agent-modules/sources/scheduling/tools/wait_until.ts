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
            "Pause this agent until a bounded date. Accept ISO 8601, RFC 2822, or a Unix timestamp in seconds or milliseconds; a past date resolves immediately. The host owns the durable wait and reports the actual elapsed time if a new message interrupts it.",
        parameters: schedulingWaitUntilToolInputSchema,
        returnType: schedulingWaitResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingWaitUntilToolInput, call) =>
            await scheduling.waitUntil(ctx, agentId, { ...input, id: call.id }),
        toLLM: (result) => [{ type: "text", text: scheduling.formatWaitForModel(result) }],
    });
}
