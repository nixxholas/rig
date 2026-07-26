import { parseJsonFromModelOutput } from "../utils/parseJsonFromModelOutput.js";
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
    const value = parseJsonFromModelOutput(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    {
        if (record.decision !== "allow" && record.decision !== "deny") return undefined;
        const risk = RISKS.find((candidate) => candidate === record.risk);
        const userAuthorization = AUTHORIZATIONS.find(
            (candidate) => candidate === record.user_authorization,
        );
        if (risk === undefined || userAuthorization === undefined) return undefined;
        if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
            return undefined;
        }
        return {
            decision: record.decision,
            ...(record.decision === "deny" ? { denialKind: "rejected" as const } : {}),
            reason: normalizeReason(record.reason),
            risk,
            userAuthorization,
        };
    }
}

function normalizeReason(reason: string): string {
    const normalized = reason.replace(/\s+/gu, " ").trim();
    return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}
