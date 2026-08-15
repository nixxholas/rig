import type { GoalStatus } from "@slopus/happy-agent-features";

export function humanizeGoalStatus(status: GoalStatus): string {
    if (status === "active") return "Active";
    if (status === "paused") return "Paused";
    if (status === "blocked") return "Blocked";
    return "Complete";
}
