/** The most an objective may be. Past this it is a document, and belongs in the conversation. */
export const MAX_GOAL_OBJECTIVE_CHARS = 20_000;

/** The objective as it will be stored, or a refusal explaining why it cannot be. */
export function normalizeGoalObjective(objective: string): string {
    const normalized = objective.trim();
    if (normalized.length === 0) {
        throw new Error("Goal objective must not be empty.");
    }
    if (normalized.length > MAX_GOAL_OBJECTIVE_CHARS) {
        throw new Error(
            `Goal objective must be ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString("en-US")} characters or fewer.`,
        );
    }
    return normalized;
}
