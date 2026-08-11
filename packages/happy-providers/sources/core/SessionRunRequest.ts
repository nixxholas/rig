import type { SessionContext } from "@/core/SessionContext.js";
import type { TSchema } from "@sinclair/typebox";

export type SessionReasoningEffort =
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";

export type SessionServiceTier = "priority";

export interface SessionStructuredOutput {
    name: string;
    schema: TSchema;
}

export interface SessionRunRequest {
    /** Complete rebuilt conversation context for this inference turn. */
    context: SessionContext;
    abort?: AbortSignal;
    model?: string;
    effort?: SessionReasoningEffort;
    serviceTier?: SessionServiceTier;
    structuredOutput?: SessionStructuredOutput;
}
