import type { SessionEvent } from "@/core/SessionEvent.js";

type ErrorDone = Extract<SessionEvent, { type: "done"; state: "error" }>;

export function classifyResponsesError(error: unknown): ErrorDone {
    const status = errorStatus(error);
    const message = error instanceof Error ? error.message : "Responses API request failed.";
    const normalized = message.toLowerCase();
    if (status === 401 || status === 403) {
        return {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "Authentication with the Responses API failed.",
            providerError: { type: "authentication" },
        };
    }
    if (status === 429) {
        return {
            type: "done",
            state: "error",
            kind: "unknown",
            message: "The Responses API rate limit was reached.",
            providerError: { type: "rate_limit" },
        };
    }
    if (
        status === 413 ||
        normalized.includes("context_length") ||
        normalized.includes("context window") ||
        normalized.includes("too many tokens")
    ) {
        return {
            type: "done",
            state: "error",
            kind: "context_overflow",
            message: "The conversation exceeds the model's context window.",
            providerError: { type: "unclassified" },
        };
    }
    if (status === 402) {
        return {
            type: "done",
            state: "error",
            kind: "billing_error",
            message: "The Responses API rejected the request because billing is unavailable.",
            providerError: { type: "unclassified" },
        };
    }
    if (status === 503 || normalized.includes("overloaded")) {
        return {
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "The Responses API is temporarily overloaded.",
            providerError: { type: "server_overloaded" },
        };
    }
    if (status !== undefined && status >= 500) {
        return {
            type: "done",
            state: "error",
            kind: "internal_error",
            message: "The Responses API returned an internal server error.",
            providerError: { type: "internal_server_error" },
        };
    }
    return {
        type: "done",
        state: "error",
        kind: "unknown",
        message,
        providerError: { type: "unclassified" },
    };
}

function errorStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
    return typeof error.status === "number" ? error.status : undefined;
}
