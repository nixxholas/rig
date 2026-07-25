import type { SessionErrorKind } from "@/core/SessionEvent.js";
import { grokErrorStatus } from "@/vendors/grok/impl/grokRetry.js";

const CONTEXT_OVERFLOW_PATTERNS = [
    "too long for this model",
    "prompt is too long",
    "maximum prompt length",
    "maximum context length",
    "context_length_exceeded",
] as const;

const BILLING_PATTERNS = [
    "subscription:free-usage-exhausted",
    "free grok build usage limit",
    "credit balance is too low",
    "out of credits",
    "insufficient credits",
    "payment required",
    "purchase more credits",
] as const;

const INTERNAL_ERROR_PATTERNS = [
    "internal server error",
    "serialization error",
    "inference idle timeout",
    "empty response from model",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "reqwest error stream",
    "stream error",
    "eventstreamerror",
] as const;

const AUTH_MESSAGE_PATTERNS = [
    "invalid or expired credentials",
    "no auth context",
    "permissiondenied",
    "unauthorized",
    "invalid api key",
    "invalid authentication",
    "missing credentials",
] as const;

/** Rejections that mean a compaction attempt will fail the same way if it is repeated. */
const PERMANENT_COMPACTION_PATTERNS = [
    "invalid_request_error",
    "authentication failed",
    "invalid client configuration",
    "invalid configuration",
    "serialization error",
    "failed to parse api response",
    "inference idle timeout",
    "model stopped responding",
    "response truncated by max_tokens",
] as const;

/** Mirrors `xai_grok_sampling_types::is_context_length_error`. */
export function isGrokContextOverflowError(message: string): boolean {
    const normalized = message.toLowerCase();
    return CONTEXT_OVERFLOW_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/** Mirrors grok-build free-usage and credit-exhaustion sniffers. */
export function isGrokBillingError(message: string): boolean {
    const normalized = message.toLowerCase();
    return BILLING_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function classifyGrokError(message: string): SessionErrorKind {
    if (isGrokContextOverflowError(message)) {
        return "context_overflow";
    }
    if (isGrokBillingError(message)) {
        return "billing_error";
    }
    if (isGrokInternalError(message)) {
        return "internal_error";
    }
    return "unknown";
}

/** Recognizes the upstream rejections that mean the stored credential is no longer usable. */
export function isGrokAuthError(options: { message: string; status?: number }): boolean {
    if (options.status === 401 || options.status === 403) return true;
    const normalized = options.message.toLowerCase();
    return AUTH_MESSAGE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/** Recognizes rejections that succeed once the oversized images are removed from the context. */
export function isGrokImageStripError(error: unknown): boolean {
    const status = grokErrorStatus(error);
    const message =
        error instanceof Error
            ? error.message
            : typeof error === "object" &&
                error !== null &&
                "message" in error &&
                typeof error.message === "string"
              ? error.message
              : String(error);
    return (
        status === 413 ||
        ((status === 400 || status === 500) && message.includes("Could not process image"))
    );
}

export function isRetryableGrokCompactionError(message: string): boolean {
    const normalized = message.toLowerCase();
    if (
        isGrokContextOverflowError(message) ||
        PERMANENT_COMPACTION_PATTERNS.some((pattern) => normalized.includes(pattern))
    ) {
        return false;
    }

    const status = message.match(/(?:^|\D)(\d{3})(?:\D|$)/u)?.[1];
    if (status === undefined) return true;
    const code = Number(status);
    return code === 408 || code === 429 || code >= 500;
}

function isGrokInternalError(message: string): boolean {
    const normalized = message.toLowerCase();
    if (/(?:^|\D)5\d{2}(?:\D|$)/u.test(message)) {
        return true;
    }
    return INTERNAL_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}
