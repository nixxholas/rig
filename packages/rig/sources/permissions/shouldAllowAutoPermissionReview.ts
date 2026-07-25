import type { AutoPermissionReview } from "./parseAutoPermissionReview.js";

/**
 * Re-derives the decision from risk and authorization so a reviewer cannot allow an action its
 * own classification does not support.
 */
export function shouldAllowAutoPermissionReview(review: AutoPermissionReview): boolean {
    if (review.decision !== "allow") return false;
    // Nothing authorizes exfiltration or major irreversible destruction automatically.
    if (review.risk === "critical") return false;
    if (review.risk !== "high") return true;
    return review.userAuthorization === "medium" || review.userAuthorization === "high";
}
