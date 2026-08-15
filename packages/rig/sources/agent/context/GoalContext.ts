import type { CreateGoalRequest, GoalStatus, SessionGoal } from "../../goals/index.js";

export interface GoalContext {
    create(request: CreateGoalRequest): Promise<SessionGoal>;
    get(): SessionGoal | undefined;
    update(status: Extract<GoalStatus, "blocked" | "complete">): Promise<SessionGoal>;
}
