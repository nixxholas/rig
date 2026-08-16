import type { PermissionReviewDecision } from "../PermissionReviewer.js";

/**
 * Re-derives whether an allowed review fits the independent Auto policy. A reviewer cannot
 * authorize a critical action, and a high-risk action needs at least medium user authorization.
 */
export function shouldAllowAutoPermissionReview(decision: PermissionReviewDecision): boolean {
    if (decision.outcome !== "allowed") return false;
    if (decision.risk === "critical") return false;
    if (decision.risk !== "high") return true;
    return decision.userAuthorization === "medium" || decision.userAuthorization === "high";
}

export function autoPermissionPolicyDenialReason(decision: PermissionReviewDecision): string {
    if (decision.outcome !== "allowed") return decision.reason;
    if (decision.risk === "critical") {
        return "The independent Auto policy does not allow critical-risk actions, even when the reviewer says allowed.";
    }
    return (
        `The independent Auto policy requires at least medium user authorization for high-risk ` +
        `actions, but this review reported ${decision.userAuthorization} authorization.`
    );
}
