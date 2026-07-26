import { Agent } from "../agent/Agent.js";
import type { AgentContext } from "../agent/context/AgentContext.js";
import {
    PERMISSION_REVIEW_FOLLOWUP_REMINDER,
    PERMISSION_REVIEW_INSTRUCTIONS,
} from "../agent/prompt/permissionReviewInstructions.js";
import type { AnyDefinedTool, Message } from "../agent/types.js";
import type { Model, Provider } from "@slopus/rig-execution";
import { createAutoPermissionTranscript } from "./createAutoPermissionTranscript.js";
import type {
    PermissionReviewAgent,
    PermissionReviewRequest,
    PermissionReviewResponse,
    PermissionReviewTranscript,
    PermissionReviewTranscriptEntry,
} from "./PermissionReviewAgent.js";
import { addUsage } from "../server/sessionUsage/addUsage.js";
import { zeroUsage } from "../server/sessionUsage/zeroUsage.js";

/**
 * Builds the sister agent that reviews Auto permission decisions.
 *
 * The caller supplies a context whose filesystem and shell are already bound to their own
 * read-only permissions, so the reviewer cannot change the workspace and cannot be widened by the
 * agent it reviews. Its permission mode is never Auto, which is what stops a review from
 * recursing into another review.
 *
 * The reviewer keeps its history across reviews, matching Codex's guardian. Because it does, each
 * review sends only the conversation it has not already seen; resending the whole transcript would
 * duplicate every earlier review's context inside the next one.
 */
export function createPermissionReviewSideAgent(options: {
    context: AgentContext;
    id: string;
    model: Model;
    provider: Provider;
    startDate?: string;
    tools: readonly AnyDefinedTool[];
}): PermissionReviewAgent {
    if (options.context.permissions?.mode === "auto") {
        throw new Error("The permission review agent must not run in Auto mode.");
    }
    const agent = new Agent({
        allowReviewerModel: true,
        context: options.context,
        id: options.id,
        modelId: options.model.id,
        printToConsole: false,
        // The reviewer reads the project instructions for the same reason Codex's guardian does:
        // without them a project-defined request is unintelligible, and the reviewer mistakes a
        // precise instruction for a vague one. They describe what the user asked for; they never
        // authorize anything by themselves, which the review policy states explicitly.
        projectInstructions: "include",
        provider: options.provider,
        ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
        systemPrompt: PERMISSION_REVIEW_INSTRUCTIONS,
        tools: options.tools,
    });
    let reviewedMessageCount = 0;
    // Where this review's own work starts inside the reviewer's history. The reviewer keeps that
    // history across reviews, so without an offset every review would re-report earlier reviews'
    // reasoning and re-count their tokens.
    let reportedOwnMessageCount = 0;
    let reviewQueue = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = reviewQueue.then(operation);
        reviewQueue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };
    // A review that never finished leaves a question with no answer at the end of the reviewer's
    // history, and the next review would stack its own question on top of that. Start the
    // reviewer over instead, which also means the next review has to resend the conversation.
    const discardUnfinishedReview = async (): Promise<void> => {
        reviewedMessageCount = 0;
        reportedOwnMessageCount = 0;
        await agent.reset();
    };
    return {
        reset: () => serialize(discardUnfinishedReview),
        review: (request: PermissionReviewRequest): Promise<PermissionReviewResponse> =>
            serialize(async () => {
                const first = reviewedMessageCount === 0;
                // Older turns are already in the reviewer's own history, so only the new ones are
                // sent. Budgeting still runs over the whole conversation, because whether user
                // authorization survived the budget is a property of all of it, not of the delta.
                const whole = createAutoPermissionTranscript(request.messages);
                const delta = first
                    ? whole
                    : createAutoPermissionTranscript(request.messages.slice(reviewedMessageCount));
                const conversation =
                    delta.text.length === 0
                        ? "No new conversation since your last review."
                        : delta.text;
                const prompt = [
                    ...(first ? [] : [PERMISSION_REVIEW_FOLLOWUP_REMINDER, ""]),
                    `<conversation${first ? "" : ' continued="true"'}>`,
                    conversation,
                    "</conversation>",
                    "",
                    "<proposed_action>",
                    request.action,
                    "</proposed_action>",
                ].join("\n");
                let result;
                try {
                    result = await agent.send(
                        prompt,
                        request.signal === undefined ? {} : { signal: request.signal },
                    );
                } catch (error) {
                    await discardUnfinishedReview();
                    throw error;
                }
                // An unfinished review still spent whatever it spent before it stopped, so its
                // work is reported either way and only the reusable history is discarded.
                const own = result.messages.slice(reportedOwnMessageCount);
                const transcript = createReviewTranscript(
                    own,
                    options.model.id,
                    options.provider.id,
                );
                if (result.stopReason !== "stop") {
                    await discardUnfinishedReview();
                    return {
                        text: "",
                        userEvidenceOmitted: whole.userEvidenceOmitted,
                        ...(transcript === undefined ? {} : { transcript }),
                    };
                }
                reviewedMessageCount = request.messages.length;
                reportedOwnMessageCount = result.messages.length;
                return {
                    text: finalText(result.messages),
                    userEvidenceOmitted: whole.userEvidenceOmitted,
                    ...(transcript === undefined ? {} : { transcript }),
                };
            }),
        close: () => serialize(() => agent.close()),
    };
}

/**
 * Records what one review did, bounded so a reviewer that investigates at length cannot grow the
 * session's stored history without limit. Usage is summed before any entry is dropped, so what a
 * review cost stays exact even when what it said is abbreviated.
 */
function createReviewTranscript(
    own: readonly Message[],
    modelId: string,
    providerId: string,
): PermissionReviewTranscript | undefined {
    const entries: PermissionReviewTranscriptEntry[] = [];
    let usage = zeroUsage();
    let inferred = false;
    for (const message of own) {
        if (message.role !== "agent") continue;
        if (message.usage !== undefined) {
            usage = addUsage(usage, message.usage);
            inferred = true;
        }
        for (const block of message.blocks) {
            if (block.type === "thinking") {
                entries.push({ type: "thinking", text: block.thinking });
            } else if (block.type === "text") {
                entries.push({ type: "text", text: block.text });
            } else if (block.type === "tool_call") {
                entries.push({
                    type: "tool_call",
                    name: block.name,
                    arguments: safeJson(block.arguments),
                });
            } else if (block.type === "tool_result") {
                entries.push({
                    type: "tool_result",
                    name: block.toolName,
                    isError: block.isError === true,
                    text: block.rendered
                        .map((part) => (part.type === "text" ? part.text : "[image]"))
                        .join("\n"),
                });
            }
        }
    }
    if (!inferred && entries.length === 0) return undefined;
    return { entries: boundEntries(entries), modelId, providerId, usage };
}

const MAX_TRANSCRIPT_ENTRY_CHARACTERS = 2_000;
const MAX_TRANSCRIPT_ENTRIES = 60;

function boundEntries(
    entries: readonly PermissionReviewTranscriptEntry[],
): readonly PermissionReviewTranscriptEntry[] {
    // The verdict is the last thing the reviewer says, so the tail is what must survive.
    const retained = entries.slice(-MAX_TRANSCRIPT_ENTRIES);
    return retained.map((entry) =>
        entry.type === "tool_call"
            ? { ...entry, arguments: truncate(entry.arguments) }
            : { ...entry, text: truncate(entry.text) },
    );
}

function truncate(text: string): string {
    if (text.length <= MAX_TRANSCRIPT_ENTRY_CHARACTERS) return text;
    return `${text.slice(0, MAX_TRANSCRIPT_ENTRY_CHARACTERS)}\n[...truncated...]`;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

function finalText(messages: readonly Message[]): string {
    const last = [...messages].reverse().find((message) => message.role === "agent");
    if (last === undefined) return "";
    return last.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}
