import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import type { DutyModule } from "../DutyModule.js";
import { dutyBindingSchema, dutyRunSchema } from "../Duty.js";
import { formatDutyForModel } from "../impl/formatDutyForModel.js";

export function getDutyTool(duties: DutyModule, agentId: string) {
    return defineAgentTool({
        name: "get_duty",
        description: "Read this agent's machine-issued Duty binding and current run.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object(
            {
                duty: Type.Optional(dutyBindingSchema),
                run: Type.Optional(dutyRunSchema),
            },
            { additionalProperties: false },
        ),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => {
            const duty = await duties.duty(ctx, agentId);
            const run = await duties.currentRun(ctx, agentId);
            return {
                ...(duty === undefined ? {} : { duty }),
                ...(run === undefined ? {} : { run }),
            };
        },
        toLLM: ({ duty, run }) => [{ type: "text", text: formatDutyForModel(duty, run) }],
    });
}
