import { Type, type Static } from "@sinclair/typebox";

import type { Message } from "../agent/types.js";
import type { SessionEvent } from "../protocol/index.js";
import { canonicalShareJson, shareContentHash } from "../sharing/canonicalShareJson.js";
import type { ShareOpaqueEntry } from "../sharing/ShareTransport.js";

const exact = { additionalProperties: false } as const;
const VISIBLE_TRANSCRIPT_EVENT_TYPES = new Set<SessionEvent["type"]>([
    "abort_requested",
    "agent_event",
    "agent_message",
    "external_tool_call_requested",
    "external_tool_call_resolved",
    "goal_changed",
    "message_submitted",
    "run_error",
    "run_finished",
    "run_started",
    "session_archived",
    "session_reset",
    "session_rewound",
    "session_workspace_archived",
    "shell_command_finished",
    "shell_command_started",
    "steering_applied",
    "subagents_suspended",
    "system_notice",
    "user_input_detached",
    "user_input_requested",
    "user_input_resolved",
    "workflow_changed",
]);

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
}): ShareOpaqueEntry | undefined {
    const projection = project(options.source);
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

function project(source: SessionShareProjectionSource): SessionShareProjection | undefined {
    if (source.kind === "event") {
        if (!VISIBLE_TRANSCRIPT_EVENT_TYPES.has(source.event.type)) return undefined;
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
