import type { DutyBinding, DutyRun } from "../Duty.js";

export function formatDutyForModel(binding: DutyBinding | undefined, run?: DutyRun): string {
    if (binding === undefined) return "This agent is not bound to a Duty.";
    const lines = [
        `Duty: ${binding.dutyId}`,
        `Tenure: ${binding.tenureId}`,
        `Status: ${binding.status}`,
        `Permission ceiling: ${binding.permissionCeiling}`,
        `Allowed tools: ${binding.allowedTools.length === 0 ? "none" : binding.allowedTools.join(", ")}`,
        `Charter: ${binding.charter}`,
    ];
    if (run !== undefined)
        lines.push(`Current run: ${run.runId} (${run.status})`, `Trigger: ${run.trigger}`);
    return lines.join("\n");
}
