import type { Message } from "../../agent/types.js";

/** One immutable message occurrence in Rig's external conversation projection. */
export interface PersistedConversationMessage {
    readonly message: Message;
    readonly position: number;
    readonly runId?: string;
}
