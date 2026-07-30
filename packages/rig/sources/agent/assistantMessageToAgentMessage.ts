import type { ToolCallPresentation } from "./ToolCallPresentation.js";
import type { AgentBlock, AgentMessage, ToolCallBlock } from "./types.js";
import type {
    AssistantContent as ProviderAssistantContent,
    AssistantMessage as ProviderAssistantMessage,
    ToolCall as ProviderToolCall,
} from "@slopus/rig-execution";

export function assistantMessageToAgentMessage(
    message: ProviderAssistantMessage,
    messageId: string,
    attribution: { providerId: string; requestedModelId: string },
    toToolCallPresentation?: (toolCall: ProviderToolCall) => ToolCallPresentation | undefined,
): AgentMessage {
    return {
        role: "agent",
        id: messageId,
        blocks: message.content.map((content) =>
            providerAssistantContentToAgentBlock(content, toToolCallPresentation),
        ),
        ...(message.contextTokens === undefined ? {} : { contextTokens: message.contextTokens }),
        usage: message.usage,
        providerId: attribution.providerId,
        requestedModelId: attribution.requestedModelId,
        ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
        ...(message.responseItems === undefined ? {} : { responseItems: message.responseItems }),
    };
}

function providerAssistantContentToAgentBlock(
    content: ProviderAssistantContent,
    toToolCallPresentation?: (toolCall: ProviderToolCall) => ToolCallPresentation | undefined,
): AgentBlock {
    if (content.type === "text") {
        return {
            type: "text",
            text: content.text,
        };
    }

    if (content.type === "thinking") {
        return {
            type: "thinking",
            thinking: content.thinking,
            ...(content.encrypted !== undefined ? { encrypted: content.encrypted } : {}),
            ...(content.redacted !== undefined ? { redacted: content.redacted } : {}),
        };
    }

    return providerToolCallToAgentBlock(content, toToolCallPresentation?.(content));
}

function providerToolCallToAgentBlock(
    toolCall: ProviderToolCall,
    presentation: ToolCallPresentation | undefined,
): ToolCallBlock {
    return {
        type: "tool_call",
        id: toolCall.id,
        ...(toolCall.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: toolCall.providerToolCallId }),
        name: toolCall.name,
        ...(toolCall.namespace === undefined ? {} : { namespace: toolCall.namespace }),
        arguments: toolCall.arguments,
        ...(toolCall.incomplete === true ? { incomplete: true } : {}),
        ...(toolCall.kind === undefined ? {} : { kind: toolCall.kind }),
        ...(toolCall.vendor === undefined ? {} : { vendor: toolCall.vendor }),
        ...(presentation === undefined ? {} : { presentation }),
    };
}
