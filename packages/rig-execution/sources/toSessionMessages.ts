import type { SessionMessage } from "@slopus/happy-providers";

import type { Context } from "@/types.js";

export function toSessionMessages(messages: Context["messages"]): SessionMessage[] {
    return messages.map((message): SessionMessage => {
        if (message.role === "system") {
            // A notice keeps the caller's position. Each vendor decides its own native shape.
            return { role: "system", content: [{ type: "text", text: message.content }] };
        }
        if (message.role === "compaction") {
            return {
                role: "compaction",
                content: message.content,
                encryptedContent: message.encryptedContent,
                ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
            };
        }
        if (message.role === "user") {
            if (message.encryptedAgentMessage !== undefined) {
                return {
                    role: "agent",
                    ...message.encryptedAgentMessage,
                    ...(message.agentMessageTriggerTurn === undefined
                        ? {}
                        : { agentMessageTriggerTurn: message.agentMessageTriggerTurn }),
                };
            }
            return {
                role: "user",
                content:
                    typeof message.content === "string"
                        ? [{ type: "text", text: message.content }]
                        : message.content.map((content) =>
                              content.type === "text"
                                  ? { type: "text" as const, text: content.text }
                                  : {
                                        type: "image" as const,
                                        data: content.data,
                                        mimeType: content.mimeType,
                                    },
                          ),
            };
        }
        if (message.role === "toolResult") {
            if (message.sessionMessage !== undefined) return message.sessionMessage;
            return {
                role: "tool",
                callId: message.providerToolCallId ?? message.toolCallId,
                content: message.content.map((content) =>
                    content.type === "text"
                        ? { type: "text" as const, text: content.text }
                        : {
                              type: "image" as const,
                              data: content.data,
                              mimeType: content.mimeType,
                          },
                ),
                isError: message.isError,
                ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
            };
        }
        if (message.sessionMessage !== undefined) return message.sessionMessage;
        return {
            role: "assistant",
            content: message.content.map((content) => {
                if (content.type === "text") return { type: "text", text: content.text };
                if (content.type === "thinking") {
                    return {
                        type: "reasoning",
                        text: content.thinking,
                        ...(content.encrypted === undefined
                            ? {}
                            : { reasoning: content.encrypted }),
                    };
                }
                return {
                    type: "tool_call",
                    callId: content.providerToolCallId ?? content.id,
                    name: content.name,
                    ...(content.namespace === undefined ? {} : { namespace: content.namespace }),
                    arguments:
                        content.kind === "custom" && typeof content.arguments.input === "string"
                            ? content.arguments.input
                            : JSON.stringify(content.arguments),
                    ...(content.incomplete === true ? { incomplete: true } : {}),
                    ...(content.vendor === undefined ? {} : { vendor: content.vendor }),
                };
            }),
        };
    });
}
