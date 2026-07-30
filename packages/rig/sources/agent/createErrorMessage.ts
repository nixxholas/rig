import type { ErrorMessage } from "./types.js";

export function createErrorMessage(
    id: string,
    reason: string,
    outcome: ErrorMessage["outcome"],
    attempt?: number,
): ErrorMessage {
    return {
        blocks: [{ text: reason, type: "text" }],
        id,
        outcome,
        role: "error",
        ...(attempt === undefined ? {} : { attempt }),
    };
}