import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { workflowLaunchToolInputSchema, workflowObservedRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

/**
 * Providers require an object at the root of a tool's parameters, so the named workflow and script
 * variants stay a closed union and travel as one argument.
 */
const runWorkflowToolParametersSchema = Type.Object(
    { input: workflowLaunchToolInputSchema },
    { additionalProperties: false },
);

type RunWorkflowToolParameters = Static<typeof runWorkflowToolParametersSchema>;

export function runWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "run_workflow",
        description:
            'Start a host-managed workflow or sandboxed script orchestration. Provide a named workflow, or exactly one bounded script/scriptPath. Only use this when the user explicitly asks for a workflow, multi-agent orchestration, or "ultracode"; it can spend substantially more tokens than a normal turn. A workflow may launch at most 1,000 agents, and the host enforces its own concurrency limit. The host owns runtime, processes, filesystem, and permissions.',
        parameters: runWorkflowToolParametersSchema,
        returnType: workflowObservedRunSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: RunWorkflowToolParameters, call) =>
            await module.launchForTool(ctx, agentId, input, call.id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}
