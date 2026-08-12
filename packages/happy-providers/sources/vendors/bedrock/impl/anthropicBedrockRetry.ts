import { APIConnectionError, APIError } from "@anthropic-ai/sdk/error";

import { isEmptyResponseError } from "@/core/EmptyResponseError.js";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

const CONNECTION_FAILURE_CODES = new Set([
    "EAI_AGAIN",
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
]);

const CONNECTION_FAILURE_MESSAGES = [
    /^terminated$/iu,
    /^fetch failed$/iu,
    /socket hang up/iu,
    /^premature close$/iu,
    /other side closed/iu,
];

/**
 * Anthropic's documented error types and the HTTP statuses they correspond to. A mid-stream SSE
 * `error` event carries one of these types but no HTTP status — the SDK throws it as an APIError
 * with `status` undefined — so retry and classification map the type back onto the status it is
 * documented to be equivalent to.
 */
const ERROR_TYPE_STATUS: Record<string, number> = {
    invalid_request_error: 400,
    authentication_error: 401,
    billing_error: 402,
    permission_error: 403,
    not_found_error: 404,
    rate_limit_error: 429,
    timeout_error: 504,
    api_error: 500,
    overloaded_error: 529,
};

export function shouldRetryAnthropicBedrock(
    error: unknown,
    failedAttempts: number,
    maxRetries: number,
): boolean {
    if (failedAttempts > maxRetries) return false;
    if (isEmptyResponseError(error)) return true;
    if (isAnthropicBedrockConnectionFailure(error)) return true;
    if (!(error instanceof APIError)) return false;
    return isRetryableAnthropicBedrockStatus(resolveAnthropicBedrockErrorStatus(error));
}

function isRetryableAnthropicBedrockStatus(status: number | undefined): boolean {
    return (
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (status !== undefined && status >= 500)
    );
}

/** The error's HTTP status, or the documented equivalent for a mid-stream SSE error event. */
export function resolveAnthropicBedrockErrorStatus(error: unknown): number | undefined {
    if (!(error instanceof APIError)) return undefined;
    if (error.status !== undefined) return error.status;
    const details = anthropicBedrockStreamErrorDetails(error);
    return details === undefined ? undefined : ERROR_TYPE_STATUS[details.type];
}

/**
 * Recognizes a retryable SSE `error` event thrown mid-stream, such as an api_error or
 * overloaded_error. Unlike HTTP-level failures these arrive on an already-open response stream,
 * so the session replays them through its block_reset rollback even after content started.
 */
export function isRetryableAnthropicBedrockStreamError(error: unknown): boolean {
    const details = anthropicBedrockStreamErrorDetails(error);
    if (details === undefined) return false;
    return isRetryableAnthropicBedrockStatus(ERROR_TYPE_STATUS[details.type]);
}

/**
 * Parses the SSE `error` event body out of an APIError the SDK threw mid-stream. Such an error
 * has no HTTP status; its body is `{"type":"error","error":{"type":...,"message":...}}`.
 */
export function anthropicBedrockStreamErrorDetails(
    error: unknown,
): { type: string; message: string | undefined } | undefined {
    if (!(error instanceof APIError) || error.status !== undefined) return undefined;
    if (error instanceof APIConnectionError) return undefined;
    const body: unknown = error.error;
    const inner =
        typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    const record =
        typeof inner === "object" && inner !== null
            ? (inner as { type?: unknown; message?: unknown })
            : undefined;
    const type = typeof error.type === "string" ? error.type : record?.type;
    if (typeof type !== "string") return undefined;
    return {
        type,
        message: typeof record?.message === "string" ? record.message : undefined,
    };
}

/** Recognizes a dropped or timed-out connection, including undici's raw mid-body stream errors. */
export function isAnthropicBedrockConnectionFailure(error: unknown): boolean {
    if (isAbortError(error)) return false;
    if (error instanceof APIConnectionError) return true;
    if (hasConnectionFailureCode(error)) return true;
    const message = error instanceof Error ? error.message : undefined;
    return (
        message !== undefined &&
        CONNECTION_FAILURE_MESSAGES.some((pattern) => pattern.test(message))
    );
}

function hasConnectionFailureCode(value: unknown): boolean {
    const seen = new Set<object>();
    let current = value;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
        seen.add(current);
        const record = current as { cause?: unknown; code?: unknown };
        if (typeof record.code === "string" && CONNECTION_FAILURE_CODES.has(record.code)) {
            return true;
        }
        current = record.cause;
    }
    return false;
}

function isAbortError(value: unknown): boolean {
    if (typeof value !== "object" || value === null) return false;
    const record = value as { code?: unknown; name?: unknown };
    return record.name === "AbortError" || record.code === "ABORT_ERR";
}

export function resolveAnthropicBedrockRetryDelay(
    error: unknown,
    failedAttempts: number,
    now: () => number = Date.now,
): number {
    const headers = error instanceof APIError ? error.headers : undefined;
    const retryAfterMilliseconds = headers?.get("retry-after-ms");
    if (retryAfterMilliseconds) {
        const milliseconds = Number.parseFloat(retryAfterMilliseconds);
        if (!Number.isNaN(milliseconds)) return milliseconds;
    }
    const retryAfter = headers?.get("retry-after");
    if (retryAfter) {
        const seconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(seconds)) return seconds * 1_000;
        return Date.parse(retryAfter) - now();
    }
    const baseDelay = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, failedAttempts - 1), MAX_DELAY_MS);
    return baseDelay + Math.random() * 0.25 * baseDelay;
}

export function waitForAnthropicBedrockRetry(
    milliseconds: number,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(finish, milliseconds);
        signal?.addEventListener("abort", abort, { once: true });

        function abort(): void {
            clearTimeout(timeout);
            reject(signal?.reason);
        }

        function finish(): void {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
    });
}

export function describeAnthropicBedrockRetry(
    error: unknown,
    failedAttempts: number,
    delay: number,
    maxRetries: number,
): string {
    if (isEmptyResponseError(error)) return error.message;
    const status =
        error instanceof APIError && error.status !== undefined
            ? `HTTP ${error.status}`
            : anthropicBedrockStreamErrorDetails(error) !== undefined
              ? "server error during the response stream"
              : "connection failure";
    return `Anthropic Bedrock ${status}; retrying in ${formatDelay(delay)}, attempt ${failedAttempts} of ${maxRetries}.`;
}

function formatDelay(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
    const seconds = milliseconds / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}
