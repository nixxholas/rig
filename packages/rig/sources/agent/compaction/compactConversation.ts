import { estimateMessagesTokens } from "./estimateMessagesTokens.js";
import { requestProviderCompaction } from "./requestProviderCompaction.js";
import { resolveCompactionInputTokens } from "./resolveCompactionInputTokens.js";
import { resolveAutoCompactThreshold } from "./resolveAutoCompactThreshold.js";
import type { CompactionMessage, Message } from "../types.js";
import type {
    Context,
    Message as ProviderMessage,
    Model,
    Provider,
    ServiceTier,
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
        inputTokens: resolveCompactionInputTokens(estimatedTokensBefore, options.reportedTokens),
        provider: options.provider,
        model: options.model,
        now: options.now,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const replacement = toAgentReplacementContext({
        compactionId,
        providerId: options.provider.id,
        replacement: summary.context.messages,
        source: options.messages,
        summary,
    });
    const contextMessages = [replacement.contextMessage];
    const estimatedTokensAfter = estimateProviderMessagesTokens(summary.context.messages);

    return {
        compacted: true,
        compactedMessageCount: options.messages.length,
        compactionMessage: replacement.transcriptMessage,
        contextMessages,
        estimatedTokensAfter,
        estimatedTokensBefore,
        retainedMessageCount: 0,
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
    providerId: string;
    replacement: readonly ProviderMessage[];
    source: readonly Message[];
    summary: {
        usage: {
            input: number;
            cacheRead: number;
            cacheWrite: number;
        };
    };
}): { contextMessage: CompactionMessage; transcriptMessage: CompactionMessage } {
    const beforeTokens =
        options.summary.usage.input +
        options.summary.usage.cacheRead +
        options.summary.usage.cacheWrite;
    const transcriptMessage: CompactionMessage = {
        role: "compaction",
        id: options.compactionId,
        blocks: [],
        replacedMessageIds: options.source.map((message) => message.id),
        statistics: {
            before: { exact: true, tokens: beforeTokens },
            after: {
                exact: false,
                tokens: estimateProviderMessagesTokens(options.replacement),
            },
        },
        providerId: options.providerId,
    };
    return {
        transcriptMessage,
        contextMessage: {
            ...transcriptMessage,
            replacementMessages: options.replacement,
        },
    };
}

function estimateProviderMessagesTokens(messages: readonly ProviderMessage[]): number {
    try {
        return Math.ceil(JSON.stringify(messages).length / 4);
    } catch {
        return 0;
    }
}
