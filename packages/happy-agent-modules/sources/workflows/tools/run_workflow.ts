import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { Compute } from "../../compute/Compute.js";
import { describeComputePathAction } from "../../compute/impl/describeComputePathAction.js";
import { shouldReviewComputePath } from "../../compute/impl/shouldReviewComputePath.js";
import { workflowLaunchInputSchema, workflowRunSchema } from "../Workflow.js";
import type { WorkflowsModule } from "../WorkflowsModule.js";

/**
 * Providers require an object at the root of a tool's parameters, so the inline-script and
 * saved-script variants stay a closed union and travel as one argument.
 */
const runWorkflowToolParametersSchema = Type.Object(
    { input: workflowLaunchInputSchema },
    { additionalProperties: false },
);

type RunWorkflowToolParameters = Static<typeof runWorkflowToolParametersSchema>;

const RUN_WORKFLOW_DESCRIPTION = `Run a deterministic multi-agent workflow in the background using sandboxed Python.

Provide exactly one of \`script\` or \`scriptPath\`.

Only use this tool when the user explicitly asks for a workflow, multi-agent orchestration, or "ultracode". Workflows can spend substantially more tokens than a normal turn.

The Python script coordinates agents but has no direct filesystem, shell, environment, or network access. Those capabilities remain inside the agents it starts. The final Python expression becomes the consolidated workflow result. Do not use top-level return.

Available Python globals:
- args: the JSON value passed in this tool call, or None.
- agent(prompt, options): run one agent and return its final text. Every agent must set model and effort. Optional fields are provider, label, schema, and service_tier="priority". Omit provider to use the normal account routing. With schema, the agent must return matching JSON and agent() returns the parsed value.
- parallel(requests): run requests concurrently and return results in input order. Each request is a dictionary with prompt, model, and effort; it may also use the optional agent fields. Failed items become None.
- pipeline(items, stages): process all items concurrently through sequential stages. Every stage is a dictionary with prompt, model, and effort; it may also use the optional agent fields. The original item and previous result are appended to every stage prompt. Failed items become None.
- phase(title): group later agent calls under a human-readable phase.
- log(message): include a progress note in the workflow run.
- print(...): also records a progress note.

External calls block until their agent has finished, even though agents run asynchronously. The sandbox is checkpointed and unloaded at every external-call boundary, then freshly restored afterwards, so model thinking time does not consume the script's own 30-second execution budget. Call agent(), parallel(), and pipeline() directly; do not write await. Use parallel for a barrier and pipeline when every item can advance independently.

Example:
phase("Review")
reviews = parallel([
    {"prompt": "Review authentication for bugs.", "label": "Auth review", "model": "openai/gpt-5.6-terra", "effort": "medium"},
    {"prompt": "Review storage for bugs.", "label": "Storage review", "model": "openai/gpt-5.6-terra", "effort": "medium"},
])
phase("Verify")
verified = pipeline(
    [review for review in reviews if review is not None],
    [{"prompt": "Adversarially verify this finding.", "label": "Verify finding", "model": "openai/gpt-5.6-terra", "effort": "medium"}],
)
{"verified": [result for result in verified if result is not None]}

Runs are capped at 1,000 agents. The tool returns as soon as the run has started. When the user asks you to wait for the result, call wait_workflow once; it waits for any duration, so do not poll workflow_status. Pass resumeFromRunId to continue unchanged code from an earlier run's latest checkpoint and reuse the agent calls it already paid for.`;

export function runWorkflowTool(
    module: WorkflowsModule,
    agentId: string,
    compute: Compute | undefined,
) {
    return defineAgentTool({
        name: "run_workflow",
        description: RUN_WORKFLOW_DESCRIPTION,
        parameters: runWorkflowToolParametersSchema,
        returnType: workflowRunSchema,
        durable: false,
        // An inline script is text the model already holds. A path is a file on the machine, so
        // reading it is the ordinary filesystem boundary and is reviewed and elevated like one.
        describeAutoPermissionAction: ({ input }: RunWorkflowToolParameters) =>
            !("scriptPath" in input)
                ? "starting an inline workflow"
                : compute === undefined
                  ? "reading a workflow script"
                  : describeComputePathAction(compute, input.scriptPath, "reading workflow script"),
        shouldReviewInAutoMode: async ({ input }: RunWorkflowToolParameters, ctx) =>
            await reviewsScriptPath(compute, input, ctx),
        shouldRunInFullAccessInAutoMode: async ({ input }: RunWorkflowToolParameters, ctx) =>
            await reviewsScriptPath(compute, input, ctx),
        execute: async (ctx, { input }: RunWorkflowToolParameters, call) =>
            await module.launch(ctx, agentId, input, call.id),
        toLLM: (run) => [{ type: "text", text: module.formatRunForModel(run) }],
    });
}

/**
 * An inline script is text the model already holds, so nothing is being read. A path is a file on
 * the machine, and an agent with no filesystem of its own cannot be judged to stay inside one, so
 * the reviewer decides.
 */
async function reviewsScriptPath(
    compute: Compute | undefined,
    input: RunWorkflowToolParameters["input"],
    ctx: Context,
): Promise<boolean> {
    if (!("scriptPath" in input)) return false;
    if (compute === undefined) return true;
    return await shouldReviewComputePath(compute, input.scriptPath, { write: false }, ctx);
}
