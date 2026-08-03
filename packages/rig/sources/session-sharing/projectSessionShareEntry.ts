import { createHash } from "node:crypto";

import { Type, type Static } from "@sinclair/typebox";

import type { Message } from "../agent/types.js";
import type { SessionEvent } from "../protocol/index.js";
import type { SessionShareOpaqueEntry } from "./SessionShareTransport.js";

const exact = { additionalProperties: false } as const;

export const sessionShareProjectionSchema = Type.Object(
    {
        kind: Type.Union([Type.Literal("event"), Type.Literal("message")]),
        payload: Type.Unknown(),
        position: Type.Optional(Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
        runId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        version: Type.Literal(1),
    },
    exact,
);
export type SessionShareProjection = Static<typeof sessionShareProjectionSchema>;

export type SessionShareProjectionSource =
    | {
          readonly event: SessionEvent;
          readonly kind: "event";
      }
    | {
          readonly kind: "message";
          readonly message: Message;
          readonly position: number;
          readonly runId?: string;
      };

export function projectSessionShareEntry(options: {
    createdAt: number;
    shareEventId: string;
    shareId: string;
    shareSequence: number;
    source: SessionShareProjectionSource;
}): SessionShareOpaqueEntry | undefined {
    const projection = project(options.source);
    if (projection === undefined) return undefined;
    const canonicalJson = canonicalStringify(projection);
    return {
        canonicalJson,
        contentHash: createHash("sha256").update(canonicalJson).digest("base64url"),
        createdAt: options.createdAt,
        shareEventId: options.shareEventId,
        shareId: options.shareId,
        shareSequence: options.shareSequence,
    };
}

function project(source: SessionShareProjectionSource): SessionShareProjection | undefined {
    if (source.kind === "event") {
        return { kind: "event", payload: sanitize(source.event), version: 1 };
    }
    if (source.message.internal === true) return undefined;
    return {
        kind: "message",
        payload: sanitize(source.message),
        position: source.position,
        ...(source.runId === undefined ? {} : { runId: source.runId }),
        version: 1,
    };
}

function sanitize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value === null || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
        Object.entries(source).flatMap(([key, child]) =>
            key === "encrypted" ||
            key === "encryptedAgentMessage" ||
            key === "internal" ||
            key === "replacementMessages" ||
            key === "vendor"
                ? []
                : [[key, sanitize(child)]],
        ),
    );
}

function canonicalStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
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
