import { estimateMessagesTokens } from "./estimateMessagesTokens.js";
import { requestProviderCompaction } from "./requestProviderCompaction.js";
import { resolveCompactionInputTokens } from "./resolveCompactionInputTokens.js";
import { resolveAutoCompactThreshold } from "./resolveAutoCompactThreshold.js";
import type { CompactionMessage, Message, UserMessage } from "../types.js";
import type {
    Context,
    Message as ProviderMessage,
    Model,
    Provider,
    ServiceTier,
    UserContent as ProviderUserContent,
} from "@slopus/rig-execution";

export interface CompactConversationResult {
    compacted: boolean;
    compactedMessageCount: number;
    compactionMessage?: CompactionMessage;
    contextMessages: readonly Message[];
    estimatedTokensAfter: number;
    estimatedTokensBefore: number;
    retainedMessageCount: number;
}

export async function compactConversation(options: {
    provider: Provider;
    model: Model;
    messages: readonly Message[];
    createProviderContext: (messages: readonly Message[]) => Promise<Context>;
    idFactory: () => string;
    now: () => number;
    reportedTokens?: number;
    force: boolean;
    onCompactionStart?: (event: {
        compactionId: string;
        estimatedTokensBefore: number;
    }) => void | Promise<void>;
    signal?: AbortSignal;
    serviceTier?: ServiceTier;
    startDate?: string;
    thinking?: string;
}): Promise<CompactConversationResult> {
    const estimatedTokensBefore = estimateMessagesTokens(options.messages);
    const tokensBefore = Math.max(estimatedTokensBefore, options.reportedTokens ?? 0);
    if (!options.force && tokensBefore < resolveAutoCompactThreshold(options.model)) {
        return unchanged(options.messages, estimatedTokensBefore);
    }

    if (
        options.messages.length < 2 ||
        !options.messages.some((message) => message.role === "agent")
    ) {
        return unchanged(options.messages, estimatedTokensBefore);
    }

    // Summarizing a turn whose tools have not answered describes a broken conversation, and a
    // provider replaying it sees calls with no results. The loop finishes every tool before it
    // asks for compaction, so an unanswered call here means something else compacted too early.
    // The retained tail is checked too: it survives into the new context, where an unanswered call
    // is just as broken as one inside the summary.
    assertToolCallsAnswered(options.messages);

    const compactionId = options.idFactory();
    await options.onCompactionStart?.({ compactionId, estimatedTokensBefore });
    const providerContext = await options.createProviderContext(options.messages);
    const summary = await requestProviderCompaction({
        context: providerContext,
        inputTokens: resolveCompactionInputTokens(
            estimatedTokensBefore,
            options.reportedTokens,
        ),
        provider: options.provider,
        model: options.model,
        now: options.now,
        ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
        ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const replacement = toAgentReplacementContext({
        compactionId,
        idFactory: options.idFactory,
        providerId: options.provider.id,
        replacement: summary.context.messages,
        source: options.messages,
        summary,
    });
    const contextMessages = replacement.contextMessages;
    const sourceIds = new Set(options.messages.map((message) => message.id));
    const retainedMessageCount = contextMessages.filter((message) =>
        sourceIds.has(message.id),
    ).length;

    return {
        compacted: true,
        compactedMessageCount: options.messages.length - retainedMessageCount,
        compactionMessage: replacement.compactionMessage,
        contextMessages,
        estimatedTokensAfter: estimateMessagesTokens(contextMessages),
        estimatedTokensBefore,
        retainedMessageCount,
    };
}

function assertToolCallsAnswered(messages: readonly Message[]): void {
    const answered = new Set<string>();
    for (const message of messages) {
        if (message.role !== "agent") continue;
        for (const block of message.blocks) {
            if (block.type === "tool_result") answered.add(block.toolCallId);
        }
    }
    for (const message of messages) {
        if (message.role !== "agent") continue;
        for (const block of message.blocks) {
            if (block.type === "tool_call" && !answered.has(block.id)) {
                throw new Error(
                    `Cannot compact while tool call '${block.name}' has no recorded result.`,
                );
            }
        }
    }
}

function unchanged(
    messages: readonly Message[],
    estimatedTokens: number,
): CompactConversationResult {
    return {
        compacted: false,
        compactedMessageCount: 0,
        contextMessages: messages,
        estimatedTokensAfter: estimatedTokens,
        estimatedTokensBefore: estimatedTokens,
        retainedMessageCount: messages.length,
    };
}

function toAgentReplacementContext(options: {
    compactionId: string;
    idFactory: () => string;
    providerId: string;
    replacement: readonly ProviderMessage[];
    source: readonly Message[];
    summary: {
        summary: string;
        encrypted?: { content: string; vendor?: unknown };
        usage: {
            input: number;
            cacheRead: number;
            cacheWrite: number;
        };
    };
}): { compactionMessage: CompactionMessage; contextMessages: Message[] } {
    const used = new Set<string>();
    let kind: CompactionMessage["kind"] | undefined;
    let content: string | undefined;
    let vendor: unknown;
    let insertion = -1;
    const contextMessages: Message[] = [];
    for (const message of options.replacement) {
        const preserved = findPreservedAgentMessage(message, options.source, used);
        if (preserved !== undefined) {
            used.add(preserved.id);
            contextMessages.push(preserved);
            continue;
        }
        if (message.role === "system") {
            contextMessages.push({
                role: "system",
                id: options.idFactory(),
                blocks: [{ type: "text", text: message.content }],
                internal: true,
            });
            continue;
        }
        if (message.role === "compaction") {
            if (kind !== undefined) {
                throw new Error("Provider compaction returned more than one replacement message.");
            }
            kind = "native";
            content = message.content;
            vendor = message.vendor;
            insertion = contextMessages.length;
            continue;
        }
        if (message.role === "user") {
            if (kind !== undefined) {
                throw new Error("Provider compaction returned more than one replacement message.");
            }
            const replacementText =
                typeof message.content === "string"
                    ? message.content
                    : message.content
                          .filter((block) => block.type === "text")
                          .map((block) => block.text)
                          .join("\n");
            if (
                message.sourceMessageId !== undefined ||
                replacementText !== options.summary.summary
            ) {
                throw new Error(
                    "Provider compaction returned an unmatched user message without source identity.",
                );
            }
            kind = "summary";
            content = replacementText;
            insertion = contextMessages.length;
            continue;
        }
        throw new Error(
            `Provider compaction returned an unmatched ${message.role} message in replacement context.`,
        );
    }
    if (kind === undefined || content === undefined || insertion < 0) {
        throw new Error("Provider compaction did not return a replacement message.");
    }
    const replacedMessageIds = options.source
        .filter((message) => !used.has(message.id))
        .map((message) => message.id);
    const beforeTokens =
        options.summary.usage.input +
        options.summary.usage.cacheRead +
        options.summary.usage.cacheWrite;
    const initial: CompactionMessage = {
        role: "compaction",
        id: options.compactionId,
        blocks: [{ type: "text", text: options.summary.summary }],
        kind,
        replacedMessageIds,
        statistics: {
            before: { exact: true, tokens: beforeTokens },
            after: { exact: false, tokens: 0 },
        },
        providerId: options.providerId,
        content,
        ...(vendor === undefined ? {} : { vendor }),
        summary: options.summary.summary,
    };
    contextMessages.splice(insertion, 0, initial);
    const compactionMessage: CompactionMessage = {
        ...initial,
        statistics: {
            ...initial.statistics,
            after: {
                exact: false,
                tokens: estimateMessagesTokens(contextMessages),
            },
        },
    };
    contextMessages[insertion] = compactionMessage;
    return { compactionMessage, contextMessages };
}

function findPreservedAgentMessage(
    providerMessage: ProviderMessage,
    source: readonly Message[],
    used: ReadonlySet<string>,
): Message | undefined {
    if (
        (providerMessage.role === "system" || providerMessage.role === "user") &&
        providerMessage.sourceMessageId !== undefined
    ) {
        return source.find(
            (message) =>
                !used.has(message.id) && message.id === providerMessage.sourceMessageId,
        );
    }
    if (providerMessage.role === "system") {
        return source.find(
            (message) =>
                !used.has(message.id) &&
                message.role === "system" &&
                message.blocks
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n") === providerMessage.content,
        );
    }
    if (providerMessage.role === "user") {
        return source.find(
            (message) =>
                !used.has(message.id) &&
                message.role === "user" &&
                message.encryptedAgentMessage === undefined &&
                sameProviderContent(
                    message.blocks.map(agentContentToProviderContent),
                    typeof providerMessage.content === "string"
                        ? [{ type: "text", text: providerMessage.content }]
                        : providerMessage.content,
                ),
        );
    }
    return undefined;
}

function sameProviderContent(
    left: readonly ProviderUserContent[],
    right: readonly ProviderUserContent[],
): boolean {
    if (left.length !== right.length) return false;
    return left.every((block, index) => {
        const other = right[index];
        if (other === undefined || block.type !== other.type) return false;
        if (block.type === "text" && other.type === "text") {
            return (
                block.text === other.text &&
                Object.keys(block).length === Object.keys(other).length
            );
        }
        return (
            block.type === "image" &&
            other.type === "image" &&
            block.data === other.data &&
            block.mimeType === other.mimeType &&
            block.detail === other.detail &&
            Object.keys(block).length === Object.keys(other).length
        );
    });
}

function agentContentToProviderContent(
    block: UserMessage["blocks"][number],
): ProviderUserContent {
    return block.type === "text"
        ? { type: "text", text: block.text }
        : {
              type: "image",
              data: block.data,
              mimeType: block.mediaType,
              ...(block.detail === undefined ? {} : { detail: block.detail }),
          };
}
