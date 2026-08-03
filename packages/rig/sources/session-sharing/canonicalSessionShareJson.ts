import { createHash } from "node:crypto";

/**
 * Canonical JSON used for every opaque session-share entry.
 *
 * The owner canonicalizes before publishing and a member canonicalizes the
 * payload it authenticated, so both sides derive the identical bytes and the
 * identical content hash for the same entry.
 */
export function canonicalSessionShareJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

export function sessionShareContentHash(canonicalJson: string): string {
    return createHash("sha256").update(canonicalJson).digest("base64url");
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonicalize(child)]),
    );
}
