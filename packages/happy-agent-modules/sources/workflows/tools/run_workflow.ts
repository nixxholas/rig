import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowLaunchToolInputSchema,
    workflowRunSchema,
    type WorkflowLaunchToolInput,
} from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

export function runWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "run_workflow",
        description:
            "Start a host-managed workflow. The host owns runtime, processes, filesystem, and permissions.",
        parameters: workflowLaunchToolInputSchema,
        returnType: workflowRunSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowLaunchToolInput, call) =>
            await module.launchForTool(ctx, agentId, input, call.id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}
