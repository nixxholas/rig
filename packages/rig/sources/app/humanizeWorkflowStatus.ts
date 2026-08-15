import type { WorkflowStatus } from "@slopus/happy-agent-features";

export function humanizeWorkflowStatus(status: WorkflowStatus): string {
    if (status === "completed") return "Completed";
    if (status === "failed") return "Failed";
    if (status === "cancelled") return "Cancelled";
    if (status === "unavailable") return "Unavailable";
    if (status === "queued") return "Queued";
    if (status === "paused") return "Paused";
    return "Running";
}
