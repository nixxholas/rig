import type { PermissionReviewTranscript } from "./PermissionReviewAgent.js";

export type AutoPermissionRisk = "low" | "medium" | "high" | "critical";
export type AutoPermissionUserAuthorization = "unknown" | "low" | "medium" | "high";

/**
 * Why an action was refused, which decides what the agent is told to do next.
 *
 * A reviewed refusal is a judgement about the action itself, so the agent must not route around
 * it. A refusal the reviewer never actually made carries no such judgement, so the agent is told
 * the action is merely unproven rather than unsafe.
 */
export type AutoPermissionDenialKind = "rejected" | "timed_out" | "unavailable";

export interface AutoPermissionReview {
    decision: "allow" | "deny";
    denialKind?: AutoPermissionDenialKind;
    reason: string;
    risk: AutoPermissionRisk;
    userAuthorization: AutoPermissionUserAuthorization;
    /** What the reviewer did to reach this verdict, and what that cost. */
    transcript?: PermissionReviewTranscript;
}

const RISKS: readonly AutoPermissionRisk[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: readonly AutoPermissionUserAuthorization[] = [
    "unknown",
    "low",
    "medium",
    "high",
];

export function parseAutoPermissionReview(text: string): AutoPermissionReview | undefined {
    const value = parseGuardianJson(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.outcome !== "allow" && record.outcome !== "deny") return undefined;
    const risk = RISKS.find((candidate) => candidate === record.risk_level);
    if (record.risk_level != null && risk === undefined) return undefined;
    const userAuthorization = AUTHORIZATIONS.find(
        (candidate) => candidate === record.user_authorization,
    );
    if (record.user_authorization != null && userAuthorization === undefined) return undefined;
    if (record.rationale != null && typeof record.rationale !== "string") return undefined;
    const rationale =
        typeof record.rationale === "string" && record.rationale.trim().length > 0
            ? record.rationale
            : record.outcome === "allow"
              ? "Auto-review returned a low-risk allow decision."
              : "Auto-review returned a deny decision without a rationale.";
    return {
        decision: record.outcome,
        ...(record.outcome === "deny" ? { denialKind: "rejected" as const } : {}),
        reason: normalizeReason(rationale),
        risk: risk ?? (record.outcome === "allow" ? "low" : "high"),
        userAuthorization: userAuthorization ?? "unknown",
    };
}

/**
 * Matches Codex Guardian's thin recovery path: prefer strict JSON, then accept the text between
 * the first opening and last closing brace when the model wrapped its assessment in prose.
 */
function parseGuardianJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start < 0 || end <= start) return undefined;
        try {
            return JSON.parse(text.slice(start, end + 1));
        } catch {
            return undefined;
        }
    }
}

function normalizeReason(reason: string): string {
    const normalized = reason.replace(/\s+/gu, " ").trim();
    return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}
