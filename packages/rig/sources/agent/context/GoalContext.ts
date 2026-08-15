import type { GoalStatus, SessionGoal } from "@slopus/happy-agent-features";

export interface GoalContext {
    create(request: { objective: string }): Promise<SessionGoal>;
    get(): SessionGoal | undefined;
    update(status: Extract<GoalStatus, "blocked" | "complete">): Promise<SessionGoal>;
}
