import type { SessionAgentMetadata } from "../../protocol/index.js";

export function sessionOrderKeyForCreation(
    sessionType: SessionAgentMetadata["type"] | undefined,
    createLastOrderKey: () => string,
): string {
    // A subagent belongs to the session that started it, not to the sidebar.
    // Giving it a position would put it in an ordered list it is not part of.
    return sessionType === "subagent" ? "" : createLastOrderKey();
}
