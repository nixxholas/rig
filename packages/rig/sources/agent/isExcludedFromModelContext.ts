import type { Message } from "./types.js";

/** Whether a durable visible message must stay out of every model-facing transcript. */
export function isExcludedFromModelContext(message: Message): boolean {
    return message.role === "error" && message.context === "excluded";
}
