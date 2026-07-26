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
} from "./PermissionReviewAgent.js";

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
        // AGENTS.md is repository content, so it is evidence for the reviewer at most, never
        // instructions to it.
        projectInstructions: "exclude",
        provider: options.provider,
        ...(options.startDate === undefined ? {} : { startDate: options.startDate }),
        systemPrompt: PERMISSION_REVIEW_INSTRUCTIONS,
        tools: options.tools,
    });
    let reviewedMessageCount = 0;
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
                if (result.stopReason !== "stop") {
                    await discardUnfinishedReview();
                    return { text: "", userEvidenceOmitted: whole.userEvidenceOmitted };
                }
                reviewedMessageCount = request.messages.length;
                return {
                    text: finalText(result.messages),
                    userEvidenceOmitted: whole.userEvidenceOmitted,
                };
            }),
        close: () => serialize(() => agent.close()),
    };
}

function finalText(messages: readonly Message[]): string {
    const last = [...messages].reverse().find((message) => message.role === "agent");
    if (last === undefined) return "";
    return last.blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}
