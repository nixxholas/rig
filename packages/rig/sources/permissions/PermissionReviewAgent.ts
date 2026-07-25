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
    /** True when user authorization history did not fit, which forces a fail-closed result. */
    userEvidenceOmitted: boolean;
}

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
    review(request: PermissionReviewRequest): Promise<PermissionReviewResponse>;
    close(): Promise<void>;
}
