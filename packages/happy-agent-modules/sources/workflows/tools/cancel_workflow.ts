import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowMutationResultSchema,
    workflowMutationToolInputSchema,
    type WorkflowMutationToolInput,
} from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

export function cancelWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "cancel_workflow",
        description:
            "Cancel one queued, running, or paused host-managed workflow. Terminal runs remain unchanged.",
        parameters: workflowMutationToolInputSchema,
        returnType: workflowMutationResultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowMutationToolInput, call) =>
            await module.cancelForTool(ctx, agentId, input, call.id),
        toLLM: (result) => [{ type: "text", text: module.formatRunForModel(result.run) }],
    });
}
