import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    workflowLaunchToolInputSchema,
    workflowObservedRunSchema,
    type WorkflowLaunchToolInput,
} from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

export function runWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "run_workflow",
        description:
            'Start a host-managed workflow or sandboxed script orchestration. Provide a named workflow, or exactly one bounded script/scriptPath. Only use this when the user explicitly asks for a workflow, multi-agent orchestration, or "ultracode"; it can spend substantially more tokens than a normal turn. A workflow may launch at most 1,000 agents, and the host enforces its own concurrency limit. The host owns runtime, processes, filesystem, and permissions.',
        parameters: workflowLaunchToolInputSchema,
        returnType: workflowObservedRunSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: WorkflowLaunchToolInput, call) =>
            await module.launchForTool(ctx, agentId, input, call.id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}
