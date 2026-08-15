import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowMutationToolInputSchema,
    workflowMutationResultSchema,
    type WorkflowMutationToolInput,
} from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

export function resumeWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "resume_workflow",
        description:
            "Resume one paused host-managed workflow run. A running run is an unchanged no-op.",
        parameters: workflowMutationToolInputSchema,
        returnType: workflowMutationResultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowMutationToolInput, call) =>
            await module.resumeForTool(ctx, agentId, input, call),
        toLLM: (result) => [{ type: "text", text: module.formatRunForModel(result.run) }],
    });
}
