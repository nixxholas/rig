import type { SharedToolOutput } from "../SharedToolOutput.js";
import { shareFlag, sharePick, shareRecord, shareText } from "./shareReadValue.js";

/**
 * How a tool call and its result cross the sharing boundary.
 *
 * The friend is told what the agent did and how it turned out. The payload — the
 * file it read, what the command printed, the diff it wrote, the matches it
 * found, whatever an MCP server sent back — stays on the owner's machine unless
 * two separate things are true: the tool declared its output disclosable, and
 * the owner set this share to replicate full output.
 *
 * Nothing here looks at the tool's name. The summary and the disclosure were
 * decided by the tool definition itself when the call ran and were recorded on
 * the block; a block that carries neither is a tool this projection cannot
 * describe, and it becomes the smallest honest row instead of a passthrough.
 */
export function shareProjectToolCall(
    block: Record<string, unknown>,
    toolOutput: SharedToolOutput,
): Record<string, unknown> | undefined {
    const id = shareText(block.id);
    const name = shareText(block.name);
    if (id === undefined || name === undefined) return undefined;
    const shared = shareRecord(block.shared);
    const summary = shareText(shared?.summary);
    return {
        type: "tool_call",
        id,
        name,
        ...sharePick(block, ["namespace"], shareText),
        ...(block.incomplete === true ? { incomplete: true } : {}),
        ...(summary === undefined ? {} : { summary }),
        // The raw arguments are payload as often as the output is: a write
        // carries the whole file, a patch carries the whole diff, a command
        // carries whatever was typed into it.
        ...(discloses(shared, toolOutput) ? { arguments: block.arguments ?? null } : {}),
    };
}

export function shareProjectToolResult(
    block: Record<string, unknown>,
    toolOutput: SharedToolOutput,
): Record<string, unknown> | undefined {
    const toolCallId = shareText(block.toolCallId);
    const toolName = shareText(block.toolName);
    if (toolCallId === undefined || toolName === undefined) return undefined;
    const shared = shareRecord(block.shared);
    const failure = shareRecord(block.failure);
    const failureKind = toFailureKind(failure?.kind);
    const isError = shareFlag(block.isError);
    const summary =
        shareText(shared?.summary) ?? describeUnsummarizedOutcome(failureKind, isError === true);
    const disclosed = discloses(shared, toolOutput);
    return {
        type: "tool_result",
        toolCallId,
        toolName,
        summary,
        ...(isError === undefined ? {} : { isError }),
        // Only the failure's kind. Its message is frequently the text a failing
        // command, an external tool, or a thrown error produced, which is the
        // very payload this projection exists to hold back.
        ...(failureKind === undefined ? {} : { failure: { kind: failureKind } }),
        ...(disclosed
            ? {
                  display: shareText(block.display) ?? "",
                  rendered: Array.isArray(block.rendered) ? block.rendered : [],
                  ...(block.presentation === undefined ? {} : { presentation: block.presentation }),
                  ...(failure?.message === undefined
                      ? {}
                      : { failureMessage: shareText(failure.message) ?? "" }),
              }
            : // A friend should not have to guess whether a tool printed nothing
              // or whether the owner is simply not sending it. Saying that
              // something was held back is the honest half of holding it back.
              { withheld: true }),
    };
}

function discloses(
    shared: Record<string, unknown> | undefined,
    toolOutput: SharedToolOutput,
): boolean {
    return toolOutput === "full" && shared?.disclosable === true;
}

const FAILURE_KINDS = new Set([
    "execution_failed",
    "interrupted",
    "invalid_arguments",
    "tool_unavailable",
]);

function toFailureKind(value: unknown): string | undefined {
    const kind = shareText(value);
    return kind !== undefined && FAILURE_KINDS.has(kind) ? kind : undefined;
}

/**
 * What a shared transcript says about a tool that supplied no summary.
 *
 * A friend still learns that the step happened and whether it worked, which is
 * the part of a failure that stays legible without the payload behind it.
 */
function describeUnsummarizedOutcome(failureKind: string | undefined, isError: boolean): string {
    if (failureKind === "interrupted") return "The tool was interrupted before it finished.";
    if (failureKind === "tool_unavailable") return "The tool was not available.";
    if (failureKind === "invalid_arguments") return "The tool was called with invalid arguments.";
    if (failureKind === "execution_failed" || isError) return "The tool failed.";
    return "The tool finished.";
}
