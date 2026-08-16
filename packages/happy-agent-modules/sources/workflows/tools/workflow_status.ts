import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowIdSchema, workflowObservedRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";
import { Type, type Static } from "@sinclair/typebox";

const inputSchema = Type.Object({ id: workflowIdSchema }, { additionalProperties: false });
type Input = Static<typeof inputSchema>;

export function workflowStatusTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "workflow_status",
        description:
            "Read one workflow run by ID, including its bounded agent count, accumulated progress logs, and legacy-compatible status projection.",
        parameters: inputSchema,
        returnType: Type.Union([workflowObservedRunSchema, Type.Undefined()]),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: Input) => await module.status(ctx, agentId, input.id),
        toLLM: (run) => [
            {
                type: "text",
                text:
                    run === undefined
                        ? "Workflow run was not found."
                        : module.formatRunForModel(run),
            },
        ],
    });
}
