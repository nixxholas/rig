import type { BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { SessionContext } from "@/core/SessionContext.js";

export function toAnthropicBedrockSystem(options: {
    context: SessionContext;
}): BetaTextBlockParam[] {
    const systemMessages = options.context.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.content)
        .join("\n\n");
    const text = [options.context.instructions, systemMessages].filter(Boolean).join("\n\n");
    if (text.length === 0) return [];
    return [
        {
            type: "text",
            text,
            cache_control: { type: "ephemeral" },
        },
    ];
}
