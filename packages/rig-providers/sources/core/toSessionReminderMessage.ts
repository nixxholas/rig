import type { SessionSystemMessage, SessionUserMessage } from "@/core/SessionContext.js";

/**
 * Projects a session system message onto the user role.
 *
 * Anthropic and xAI expose no system or developer role once a conversation is under way, so their
 * native clients deliver out-of-band notices as user turns wrapped in `<system-reminder>`. Folding
 * these into the system prompt instead would lose the position the caller chose and rewrite the
 * cached prefix on every notice.
 */
export function toSessionReminderMessage(message: SessionSystemMessage): SessionUserMessage {
    const parts = typeof message.content === "string" ? [message.content] : message.content;
    return {
        role: "user",
        content: `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`,
    };
}
