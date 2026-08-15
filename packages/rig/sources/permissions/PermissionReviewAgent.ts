import type { Usage } from "@slopus/rig-execution";
import type { Context } from "@steve.kite/stdlib";
import type { Message } from "../agent/types.js";

export interface PermissionReviewRequest {
    /** Tool-owned description of the exact boundary being crossed. */
    action: string;
    /** Full conversation so far. The reviewer sends only what it has not already seen. */
    messages: readonly Message[];
    signal?: AbortSignal;
}

export interface PermissionReviewResponse {
    /** The reviewer's raw final text, still to be parsed into a verdict. */
    text: string;
    /** True when user authorization history did not fit; the reviewer receives an omission marker. */
    userEvidenceOmitted: boolean;
    /**
     * What the reviewer did to reach this verdict, recorded so a decision can be explained after
     * the fact. A review that produced no inference reports no transcript.
     */
    transcript?: PermissionReviewTranscript;
}

/**
 * One review's own work: the reasoning and tool calls behind a verdict, plus what it cost.
 *
 * The reviewer spends real tokens on the user's account, so its usage is attributed to the model
 * that actually ran rather than folded into the agent it reviews.
 */
export interface PermissionReviewTranscript {
    entries: readonly PermissionReviewTranscriptEntry[];
    modelId: string;
    providerId: string;
    usage: Usage;
}

export type PermissionReviewTranscriptEntry =
    | { type: "thinking"; text: string }
    | { type: "text"; text: string }
    | { type: "tool_call"; name: string; arguments: string }
    | { type: "tool_result"; name: string; isError: boolean; text: string };

/**
 * A side agent that reviews one proposed action.
 *
 * It is a real sister agent rather than a bare inference call, so it can read the workspace to
 * judge an action. It runs read-only with a reduced tool set and is never in Auto mode itself,
 * which is what keeps a review from triggering another review.
 *
 * It owns its own conversation, so it decides how much context each review needs.
 */
export interface PermissionReviewAgent {
    review(ctx: Context, request: PermissionReviewRequest): Promise<PermissionReviewResponse>;
    /** Clears reviewer conversation state when the owning transcript is reset. */
    reset(): Promise<void>;
    close(): Promise<void>;
}
