import type { WorkflowRun } from "@slopus/happy-agent-features";

export function applyWorkflowRunUpdate(
    workflows: readonly WorkflowRun[],
    update: WorkflowRun,
): readonly WorkflowRun[] {
    const index = workflows.findIndex((workflow) => workflow.id === update.id);
    if (index < 0) {
        return [update, ...workflows].sort(
            (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
        );
    }
    return workflows.map((workflow, workflowIndex) =>
        workflowIndex === index ? update : workflow,
    );
}
