import type { DurableUserInputCall } from "./DurableUserInputCall.js";

/**
 * A question the user could still answer. It stays open once presence releases the agent from
 * waiting, because the agent's tool call finishing does not mean the user stopped caring.
 */
export function isOpenQuestion(call: DurableUserInputCall): boolean {
    return (
        call.kind === "question" &&
        call.response === undefined &&
        call.status !== "cancelled" &&
        (call.status === "pending" || call.detachedAt !== undefined)
    );
}
