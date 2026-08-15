import type { AgentPermissionMode, AnyAgentTool } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";

/** One tool call put to the reviewer, described as the action a decision is actually about. */
export interface PermissionReviewRequest {
    /** The agent whose turn wants to take this action. */
    readonly agentId: string;
    /** The ID the model attached to the call, so a decision can be tied back to it. */
    readonly callId: string;
    /** The tool definition the call resolved to, including its own Auto guidance. */
    readonly tool: AnyAgentTool;
    /** The call's validated arguments. */
    readonly arguments: unknown;
    /**
     * What the reviewer is deciding on, in the words the tool uses to describe this exact
     * invocation and the boundary it crosses.
     */
    readonly action: string;
    /**
     * The mode the agent is running in, which is always Auto: it is the only mode that reviews.
     * Carried so a reviewer's record of a decision says what it was made under.
     */
    readonly mode: AgentPermissionMode;
    /**
     * Whether allowing this action also lifts the sandbox for the length of the call, because the
     * tool says this invocation cannot be carried out inside it.
     */
    readonly elevates: boolean;
}

/**
 * What a review concluded. The two refusals are deliberately different things: a denial is a
 * decision that the action must not happen, while an unproven review is the absence of a decision —
 * a reviewer that was not there, failed, or took too long. An agent told the difference can stop
 * and explain itself rather than treating a missing answer as a verdict.
 */
export type PermissionReviewDecision =
    | { readonly outcome: "allowed"; readonly reason?: string }
    | { readonly outcome: "denied"; readonly reason: string };

/**
 * Whoever decides, on the user's behalf, whether one Auto action may go ahead. Review is automatic:
 * it must never become a question put to the person, and it must answer in bounded time.
 *
 * A reviewer that throws or takes longer than the module's timeout has not refused anything, and
 * the action is refused as unproven rather than as unsafe.
 */
export interface PermissionReviewer {
    review(ctx: Context, request: PermissionReviewRequest): Promise<PermissionReviewDecision>;
}
