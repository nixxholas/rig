import type { SessionMessage } from "@slopus/rig-providers";

import type { Context } from "@/types.js";

export function toSessionMessages(messages: Context["messages"]): SessionMessage[] {
    return messages.map((message): SessionMessage => {
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
            const input =
                typeof message.content === "string"
                    ? undefined
                    : message.content.map((content) =>
                          content.type === "text"
                              ? { type: "text" as const, text: content.text }
                              : {
                                    type: "image" as const,
                                    data: content.data,
                                    mimeType: content.mimeType,
                                },
                      );
            return {
                role: "user",
                content:
                    typeof message.content === "string"
                        ? message.content
                        : message.content
                              .filter((content) => content.type === "text")
                              .map((content) => content.text)
                              .join(""),
                ...(input === undefined ? {} : { input }),
            };
        }
        if (message.role === "toolResult") {
            const input = message.content.map((content) =>
                content.type === "text"
                    ? { type: "text" as const, text: content.text }
                    : {
                          type: "image" as const,
                          data: content.data,
                          mimeType: content.mimeType,
                      },
            );
            return {
                role: "tool",
                callId: message.toolCallId,
                content: message.content
                    .filter((content) => content.type === "text")
                    .map((content) => content.text)
                    .join(""),
                input,
                isError: message.isError,
                ...(message.vendor === undefined ? {} : { vendor: message.vendor }),
            };
        }
        const thinking = message.content.filter((content) => content.type === "thinking");
        const toolCalls = message.content
            .filter((content) => content.type === "toolCall")
            .map((content) => ({
                callId: content.id,
                name: content.name,
                ...(content.namespace === undefined ? {} : { namespace: content.namespace }),
                arguments:
                    content.kind === "custom" && typeof content.arguments.input === "string"
                        ? content.arguments.input
                        : JSON.stringify(content.arguments),
                ...(content.vendor === undefined ? {} : { vendor: content.vendor }),
            }));
        const encryptedReasoning = thinking.at(-1)?.encrypted;
        // A signature only verifies the exact text it was issued for, so the blocks travel whole
        // and in order. Vendors that treat reasoning as one opaque blob still read the field above.
        const reasoning = thinking.map((content) => ({
            text: content.thinking,
            ...(content.encrypted === undefined ? {} : { signature: content.encrypted }),
            ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
        }));
        return {
            role: "assistant",
            content: message.content
                .filter((content) => content.type === "text")
                .map((content) => content.text)
                .join(""),
            ...(encryptedReasoning === undefined ? {} : { encryptedReasoning }),
            ...(reasoning.length === 0 ? {} : { reasoning }),
            ...(toolCalls.length === 0 ? {} : { toolCalls }),
            ...(message.responseItems === undefined
                ? {}
                : { responseItems: message.responseItems }),
        };
    });
}
