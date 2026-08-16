import { Type, type Static } from "@sinclair/typebox";

/**
 * Parses the guardian's final message into a verdict, ported byte-for-byte from Rig v1's
 * `permissions/parseAutoPermissionReview.ts`.
 *
 * The recovery path is deliberately thin and must stay that way for parity: strict JSON first,
 * then the text between the first `{` and the last `}` when the model wrapped its assessment in
 * prose. The verdict's defaults, normalization, and the 240-character reason cap are the exact v1
 * behavior, so the same guardian output produces the same decision here as it did in v1.
 */

export const autoPermissionRiskSchema = Type.Union([
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("critical"),
]);

export type AutoPermissionRisk = Static<typeof autoPermissionRiskSchema>;

export const autoPermissionUserAuthorizationSchema = Type.Union([
    Type.Literal("unknown"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
]);

export type AutoPermissionUserAuthorization = Static<typeof autoPermissionUserAuthorizationSchema>;

/**
 * Why an action was refused, which decides what the agent is told to do next.
 *
 * A reviewed refusal is a judgement about the action itself, so the agent must not route around
 * it. A refusal the reviewer never actually made carries no such judgement, so the agent is told
 * the action is merely unproven rather than unsafe.
 */
export const autoPermissionDenialKindSchema = Type.Union([
    Type.Literal("rejected"),
    Type.Literal("timed_out"),
    Type.Literal("unavailable"),
]);

export type AutoPermissionDenialKind = Static<typeof autoPermissionDenialKindSchema>;

export const autoPermissionReviewSchema = Type.Object(
    {
        decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
        denialKind: Type.Optional(autoPermissionDenialKindSchema),
        reason: Type.String(),
        risk: autoPermissionRiskSchema,
        userAuthorization: autoPermissionUserAuthorizationSchema,
    },
    { additionalProperties: false },
);

export type AutoPermissionReview = Static<typeof autoPermissionReviewSchema>;

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
 * Matches the guardian's thin recovery path: prefer strict JSON, then accept the text between the
 * first opening and last closing brace when the model wrapped its assessment in prose.
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
