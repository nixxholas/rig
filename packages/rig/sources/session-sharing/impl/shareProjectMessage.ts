import type { SharedToolOutput } from "../SharedToolOutput.js";
import { shareProjectToolCall, shareProjectToolResult } from "./shareProjectToolBlock.js";
import {
    shareInteger,
    shareNumber,
    sharePick,
    shareRecord,
    shareText,
    shareTextList,
} from "./shareReadValue.js";

/**
 * One transcript message, rebuilt field by field for a friend.
 *
 * Every field a friend receives is named here. Nothing is copied because it
 * happened to be on the object: a field added to a message later does not reach
 * a shared transcript until somebody adds it to this list and decides what it
 * means to hand it to another person.
 */
export function shareProjectMessage(
    value: unknown,
    toolOutput: SharedToolOutput,
): Record<string, unknown> | undefined {
    const message = shareRecord(value);
    if (message === undefined) return undefined;
    // Durable model context is not transcript history, so it is not somebody
    // else's to read even when the session it belongs to is shared.
    if (message.internal === true) return undefined;
    const id = shareText(message.id);
    if (id === undefined) return undefined;
    const role = shareText(message.role);

    if (role === "system") {
        const structured = shareProjectServiceNotice(message.structured);
        return {
            role,
            id,
            blocks: shareProjectContentBlocks(message.blocks),
            ...(message.context === "excluded" ? { context: "excluded" } : {}),
            ...(structured === undefined ? {} : { structured }),
        };
    }

    if (role === "user") {
        // A command the user ran themselves arrives as a user message whose
        // blocks are the command's own stdout and stderr. `shell_command_started`
        // and `shell_command_finished` already tell a friend what ran and how it
        // ended, so this message has nothing left to add but its output.
        if (typeof message.shellCommandId === "string") return undefined;
        const agentSource = shareRecord(message.agentSource);
        const friendAuthor = shareProjectFriendAuthor(message.friendAuthor);
        return {
            role,
            id,
            blocks: shareProjectContentBlocks(message.blocks),
            ...(message.contextOnly === true ? { contextOnly: true } : {}),
            ...(message.agentMessageTriggerTurn === undefined
                ? {}
                : { agentMessageTriggerTurn: message.agentMessageTriggerTurn === true }),
            ...(message.provenance === "agent" ? { provenance: "agent" } : {}),
            ...(friendAuthor === undefined ? {} : { friendAuthor }),
            ...(agentSource === undefined
                ? {}
                : {
                      agentSource: sharePick(
                          agentSource,
                          ["agentId", "sessionId", "title"],
                          shareText,
                      ),
                  }),
            // `encryptedAgentMessage` is an opaque provider payload and
            // `agentsMd` fingerprints the owner's project instructions.
        };
    }

    if (role === "agent") {
        const usage = shareProjectUsage(message.usage);
        return {
            role,
            id,
            blocks: shareProjectAgentBlocks(message.blocks, toolOutput),
            ...sharePick(message, ["providerId", "requestedModelId", "responseModel"], shareText),
            ...sharePick(message, ["contextTokens"], shareInteger),
            ...(usage === undefined ? {} : { usage }),
            // `responseItems` replays the provider's own output verbatim and
            // `attachments` point at files on the owner's disk.
        };
    }

    if (role === "compaction") {
        const statistics = shareRecord(message.statistics);
        const before = shareRecord(statistics?.before);
        const after = shareRecord(statistics?.after);
        const usage = shareProjectUsage(message.usage);
        return {
            role,
            id,
            blocks: shareProjectContentBlocks(message.blocks),
            replacedMessageIds: shareTextList(message.replacedMessageIds) ?? [],
            ...sharePick(message, ["providerId", "requestedModelId", "responseModel"], shareText),
            ...(before === undefined || after === undefined
                ? {}
                : {
                      statistics: {
                          after: {
                              exact: after.exact === true,
                              tokens: shareInteger(after.tokens) ?? 0,
                          },
                          before: { exact: true, tokens: shareInteger(before.tokens) ?? 0 },
                      },
                  }),
            ...(usage === undefined ? {} : { usage }),
            // `replacementMessages` is the provider-native context the
            // compaction produced, which is the transcript in another form.
        };
    }

    if (role === "error") {
        const outcome = shareText(message.outcome);
        return {
            role,
            id,
            blocks: shareProjectContentBlocks(message.blocks),
            outcome: outcome === undefined ? "failed" : outcome,
            ...sharePick(message, ["attempt"], shareInteger),
            ...(message.context === "excluded" ? { context: "excluded" } : {}),
        };
    }

    return undefined;
}

/**
 * Text and images the person and the agent wrote to each other.
 *
 * These are the conversation itself rather than something a tool went and
 * fetched, so they replicate whole. Tool payloads never arrive here; they reach
 * a friend, if at all, through the disclosure decision on a tool result.
 */
export function shareProjectContentBlocks(value: unknown): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): readonly Record<string, unknown>[] => {
        const block = shareRecord(entry);
        if (block === undefined) return [];
        if (block.type === "text") {
            const text = shareText(block.text);
            return text === undefined ? [] : [{ type: "text", text }];
        }
        if (block.type === "image") {
            const data = shareText(block.data);
            const mediaType = shareText(block.mediaType);
            if (data === undefined || mediaType === undefined) return [];
            return [
                {
                    type: "image",
                    data,
                    mediaType,
                    ...sharePick(block, ["detail"], shareText),
                },
            ];
        }
        return [];
    });
}

function shareProjectAgentBlocks(
    value: unknown,
    toolOutput: SharedToolOutput,
): readonly Record<string, unknown>[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const block = shareRecord(entry);
        if (block === undefined) return [];
        if (block.type === "thinking") {
            const thinking = shareText(block.thinking);
            if (thinking === undefined) return [];
            return [
                {
                    type: "thinking",
                    thinking,
                    ...(block.redacted === undefined ? {} : { redacted: block.redacted === true }),
                    // `encrypted` is the provider's own signed reasoning blob.
                },
            ];
        }
        if (block.type === "tool_call") {
            const projected = shareProjectToolCall(block, toolOutput);
            return projected === undefined ? [] : [projected];
        }
        if (block.type === "tool_result") {
            const projected = shareProjectToolResult(block, toolOutput);
            return projected === undefined ? [] : [projected];
        }
        return shareProjectContentBlocks([block]);
    });
}

function shareProjectFriendAuthor(value: unknown): Record<string, unknown> | undefined {
    const author = shareRecord(value);
    if (author === undefined || author.kind !== "friend") return undefined;
    return {
        kind: "friend",
        ...sharePick(author, ["displayName", "shareId", "shareMemberId"], shareText),
        ...sharePick(author, ["grantEpoch"], shareInteger),
        // `murmurPeerId` is another member's transport identity.
    };
}

function shareProjectUsage(value: unknown): Record<string, unknown> | undefined {
    const usage = shareRecord(value);
    if (usage === undefined) return undefined;
    const cost = shareRecord(usage.cost);
    return {
        ...sharePick(
            usage,
            ["cacheRead", "cacheWrite", "input", "output", "reasoning", "totalTokens"],
            shareNumber,
        ),
        ...(cost === undefined
            ? {}
            : {
                  cost: sharePick(
                      cost,
                      ["cacheRead", "cacheWrite", "input", "output", "total"],
                      shareNumber,
                  ),
              }),
    };
}

function shareProjectServiceNotice(value: unknown): Record<string, unknown> | undefined {
    const notice = shareRecord(value);
    if (notice === undefined || notice.kind !== "compute_preparation") return undefined;
    return {
        kind: "compute_preparation",
        ...sharePick(notice, ["message", "phase", "provider", "state"], shareText),
        ...sharePick(notice, ["percent"], shareNumber),
        ...sharePick(notice, ["elapsedMs"], shareInteger),
        // `computeInstanceId` names the owner's machine and `error` carries a
        // provider failure payload rather than a sentence.
    };
}
