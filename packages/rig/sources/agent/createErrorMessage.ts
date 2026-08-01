import type { ErrorMessage } from "./types.js";

export function createErrorMessage(
    id: string,
    reason: string,
    outcome: ErrorMessage["outcome"],
    attempt?: number,
    context?: ErrorMessage["context"],
): ErrorMessage {
    return {
        blocks: [{ text: reason, type: "text" }],
        ...(context === undefined ? {} : { context }),
        id,
        outcome,
        role: "error",
        ...(attempt === undefined ? {} : { attempt }),
    };
}
