import type { SessionTokenCount, Usage } from "../protocol/index.js";

type SessionTokenCountUpdate =
    | { type: "compaction"; contextTokens: number }
    | { type: "invalidate_context" }
    | { type: "reset" }
    | { type: "usage"; contextTokens: number; usage: Usage };

const ZERO_SESSION_TOKEN_COUNT: SessionTokenCount = {
    lastContextTokens: 0,
    totalTokens: 0,
};

export function updateSessionTokenCount(
    current: SessionTokenCount | undefined,
    update: SessionTokenCountUpdate,
): SessionTokenCount {
    if (update.type === "reset") return ZERO_SESSION_TOKEN_COUNT;

    const previous = current ?? ZERO_SESSION_TOKEN_COUNT;
    if (update.type === "invalidate_context") {
        return { ...previous, lastContextTokens: 0 };
    }
    const contextTokens = Math.max(0, update.contextTokens);

    // A request's total describes the context it processed, and later requests replay the same
    // grown context, so the session counts its footprint once rather than summing every replay.
    return {
        lastContextTokens: contextTokens,
        totalTokens:
            update.type === "compaction"
                ? previous.totalTokens
                : Math.max(previous.totalTokens, update.usage.totalTokens),
    };
}
