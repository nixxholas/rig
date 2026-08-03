import { Type, type Static } from "@sinclair/typebox";

import type { Message } from "../agent/types.js";
import type { SessionEvent } from "../protocol/index.js";
import { canonicalShareJson, shareContentHash } from "../sharing/canonicalShareJson.js";
import type { ShareOpaqueEntry } from "../sharing/ShareTransport.js";
import { shareProjectEvent } from "./impl/shareProjectEvent.js";
import { shareProjectMessage } from "./impl/shareProjectMessage.js";
import type { SharedToolOutput } from "./SharedToolOutput.js";

const exact = { additionalProperties: false } as const;

/**
 * Version 1 replicated a transcript entry with five field names removed.
 *
 * Entries already delivered under it stay readable, which is why it is still
 * described here, but nothing produces it any more. Its shape was a denylist:
 * everything crossed the boundary except a handful of named fields, so a tool's
 * complete output, a file's complete contents, and a command's complete stdout
 * all replicated verbatim.
 */
export const sessionShareProjectionV1Schema = Type.Object(
    {
        kind: Type.Union([Type.Literal("event"), Type.Literal("message")]),
        payload: Type.Unknown(),
        position: Type.Optional(Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
        runId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        version: Type.Literal(1),
    },
    exact,
);
export type SessionShareProjectionV1 = Static<typeof sessionShareProjectionV1Schema>;

/**
 * Version 2 replicates what the agent did rather than what the agent saw.
 *
 * Every field in a payload is one this projection chose to include. A tool call
 * arrives as the sentence its own definition wrote for it, and its arguments and
 * output arrive only when that tool declared them disclosable and the owner set
 * this share to replicate full output.
 */
export const sessionShareProjectionSchema = Type.Object(
    {
        kind: Type.Union([Type.Literal("event"), Type.Literal("message")]),
        payload: Type.Unknown(),
        position: Type.Optional(Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 })),
        runId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        version: Type.Literal(2),
    },
    exact,
);
export type SessionShareProjection = Static<typeof sessionShareProjectionSchema>;

/** Any projection a replica may hold, including entries delivered before version 2. */
export const sessionShareAnyProjectionSchema = Type.Union([
    sessionShareProjectionV1Schema,
    sessionShareProjectionSchema,
]);
export type SessionShareAnyProjection = Static<typeof sessionShareAnyProjectionSchema>;

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
    /**
     * How much of each tool's work this share replicates. Required rather than
     * defaulted, so a caller that has not read the owner's setting cannot
     * accidentally publish under someone else's.
     */
    toolOutput: SharedToolOutput;
}): ShareOpaqueEntry | undefined {
    const projection = projectSessionShareProjection(options.source, options.toolOutput);
    if (projection === undefined) return undefined;
    const canonicalJson = canonicalShareJson(projection);
    return {
        canonicalJson,
        contentHash: shareContentHash(canonicalJson),
        createdAt: options.createdAt,
        shareEventId: options.shareEventId,
        shareId: options.shareId,
        shareSequence: options.shareSequence,
    };
}

/**
 * The transcript projection on its own, without the entry it usually travels in.
 *
 * A shared scope carries the same projection nested inside its own envelope, so
 * both kinds of share decide what is visible right here, including how much of
 * each tool's work crosses. `undefined` means the source is not part of a shared
 * transcript at all.
 */
export function projectSessionShareProjection(
    source: SessionShareProjectionSource,
    toolOutput: SharedToolOutput,
): SessionShareProjection | undefined {
    if (source.kind === "event") {
        const payload = shareProjectEvent(source.event, toolOutput);
        return payload === undefined ? undefined : { kind: "event", payload, version: 2 };
    }
    const payload = shareProjectMessage(source.message, toolOutput);
    if (payload === undefined) return undefined;
    return {
        kind: "message",
        payload,
        position: source.position,
        ...(source.runId === undefined ? {} : { runId: source.runId }),
        version: 2,
    };
}
