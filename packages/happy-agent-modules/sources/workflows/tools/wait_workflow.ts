import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { workflowIdSchema, workflowObservedRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

const inputSchema = Type.Object({ id: workflowIdSchema }, { additionalProperties: false });
type Input = Static<typeof inputSchema>;

export function waitWorkflowTool(module: WorkflowsModule, agentId: string) {
    return defineAgentTool({
        name: "wait_workflow",
        description:
            "Wait once through the host workflow broker until a run reaches a terminal or unavailable state. Do not poll this tool. If the user cancels this tool call, only this wait is cancelled; the workflow continues running in the background and can still be checked with workflow_status or workflow_logs. The host provides durability and wakeup.",
        parameters: inputSchema,
        returnType: workflowObservedRunSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: Input) => await module.waitForTool(ctx, agentId, input.id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}
