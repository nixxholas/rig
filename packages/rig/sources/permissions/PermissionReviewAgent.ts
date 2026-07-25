/**
 * A side agent that reviews one proposed action.
 *
 * It is a real sister agent rather than a bare inference call, so it can read the workspace to
 * judge an action. It runs read-only with a reduced tool set and is never in Auto mode itself,
 * which is what keeps a review from triggering another review.
 */
export interface PermissionReviewAgent {
    /** Returns the reviewer's raw final text for one action. */
    review(request: { prompt: string; signal?: AbortSignal }): Promise<string>;
    close(): Promise<void>;
}
