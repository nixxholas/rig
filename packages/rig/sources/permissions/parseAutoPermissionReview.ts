export type AutoPermissionRisk = "low" | "medium" | "high" | "critical";
export type AutoPermissionUserAuthorization = "unknown" | "low" | "medium" | "high";

export interface AutoPermissionReview {
    decision: "allow" | "ask";
    reason: string;
    risk: AutoPermissionRisk;
    userAuthorization: AutoPermissionUserAuthorization;
}

const RISKS: readonly AutoPermissionRisk[] = ["low", "medium", "high", "critical"];
const AUTHORIZATIONS: readonly AutoPermissionUserAuthorization[] = [
    "unknown",
    "low",
    "medium",
    "high",
];

export function parseAutoPermissionReview(text: string): AutoPermissionReview | undefined {
    const candidate = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)?.[1] ?? text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
        const value: unknown = JSON.parse(candidate.slice(start, end + 1));
        if (value === null || typeof value !== "object") return undefined;
        const record = value as Record<string, unknown>;
        if (record.decision !== "allow" && record.decision !== "ask") return undefined;
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
            reason: normalizeReason(record.reason),
            risk,
            userAuthorization,
        };
    } catch {
        return undefined;
    }
}

function normalizeReason(reason: string): string {
    const normalized = reason.replace(/\s+/gu, " ").trim();
    return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}…`;
}
