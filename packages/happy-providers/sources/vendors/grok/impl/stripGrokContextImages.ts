import type { SessionContext, SessionInputBlock } from "@/core/SessionContext.js";

export function stripGrokContextImages(context: SessionContext): SessionContext | undefined {
    let removed = false;
    const messages = context.messages.map((message) => {
        if (message.role !== "user" && message.role !== "tool") {
            return message;
        }
        const content = message.content.filter((block) => {
            if (block.type !== "image") return true;
            removed = true;
            return false;
        }) as readonly SessionInputBlock[];
        return { ...message, content };
    });
    return removed ? { ...context, messages } : undefined;
}
