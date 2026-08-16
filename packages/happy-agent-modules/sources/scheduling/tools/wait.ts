import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import { schedulingWaitResultSchema, schedulingWaitToolInputSchema } from "../Scheduling.js";

/**
 * Providers require an object at the root of a tool's parameters, so the duration variants stay a
 * closed union and travel as one argument.
 */
const waitToolParametersSchema = Type.Object(
    { input: schedulingWaitToolInputSchema },
    { additionalProperties: false },
);

type WaitToolParameters = Static<typeof waitToolParametersSchema>;

export function waitTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "wait",
        description:
            "Pause this agent for a bounded duration. Use seconds, minutes, hours, or days, including compound fields or human text such as '90 seconds' or '1h 30m'. The host owns the durable wait; a new message interrupts it and the result reports the time that actually elapsed.",
        parameters: waitToolParametersSchema,
        returnType: schedulingWaitResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: WaitToolParameters, call) =>
            await scheduling.wait(ctx, agentId, { ...input, id: call.id }),
        toLLM: (result) => [{ type: "text", text: scheduling.formatWaitForModel(result) }],
    });
}
