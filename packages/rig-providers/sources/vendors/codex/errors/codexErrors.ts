import type { SessionErrorKind } from "@/core/SessionEvent.js";

/**
 * Recognition of the Codex rejections that change what the session does next.
 *
 * Each predicate answers one question the session asks about a failure: whether to surface it,
 * shrink the request, replay the context, refresh the credential, fall back off WebSocket, or
 * resend it unchanged.
 */

export function classifyCodexError(message: string): SessionErrorKind {
    if (/context|prompt.+too long|maximum context|token limit/iu.test(message))
        return "context_overflow";
    if (/billing|credit|quota|usage limit|insufficient_quota/iu.test(message))
        return "billing_error";
    if (
        /status 5\d\d|fetch failed|socket|websocket|timed? ?out|service unavailable/iu.test(message)
    )
        return "internal_error";
    return "unknown";
}

/** Detects a server rejection that can be retried with a smaller compaction input. */
export function isCodexContextWindowError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /context window|context length|maximum context|too many tokens/iu.test(message);
}

const PREVIOUS_RESPONSE_NOT_FOUND = "previous_response_not_found";

export function isCodexPreviousResponseNotFoundError(error: unknown): boolean {
    const seen = new Set<object>();
    const matches = (value: unknown): boolean => {
        if (typeof value === "string") return value.includes(PREVIOUS_RESPONSE_NOT_FOUND);
        if (typeof value !== "object" || value === null || seen.has(value)) return false;
        seen.add(value);
        const record = value as Record<string, unknown>;
        if (record.code === PREVIOUS_RESPONSE_NOT_FOUND) return true;
        return [record.error, record.cause, record.body, record.message].some(matches);
    };
    return matches(error);
}

export function isCodexUnauthorizedError(error: unknown): boolean {
    return hasUnauthorized(error, new Set());
}

const BEDROCK_EXPIRED_SIGNATURE_MESSAGE =
    "Amazon Bedrock rejected the request because its AWS signature has expired. Refresh your " +
    "AWS credentials and retry. If AWS_BEARER_TOKEN_BEDROCK is set, update or unset it, then " +
    "start a new session.";

/**
 * Turns a failure into the sentence shown to a person.
 *
 * An expired AWS signature reads as a bare authorization failure, which tells the reader nothing
 * about the credential that actually went stale, so Bedrock names it the way the native client
 * does. Everything else already describes itself.
 */
export function codexErrorMessage(error: unknown, message: string): string {
    if (isCodexUnauthorizedError(error) && message.includes("Signature expired:")) {
        return BEDROCK_EXPIRED_SIGNATURE_MESSAGE;
    }
    return message;
}

function hasUnauthorized(error: unknown, seen: Set<object>): boolean {
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    if ("status" in error && error.status === 401) return true;
    return "cause" in error && hasUnauthorized(error.cause, seen);
}

export function isCodexWebSocketUnavailableError(error: unknown): boolean {
    const details = readDetails(error, new Set());
    if (details.statuses.some((status) => status === 404 || status === 405 || status === 426))
        return true;
    return (
        details.statuses.includes(400) &&
        details.messages.some((message) =>
            /\bwebsocket\b.*\b(not supported|unsupported|unavailable|upgrade required)\b/i.test(
                message,
            ),
        )
    );
}

function readDetails(
    error: unknown,
    seen: Set<object>,
): { messages: string[]; statuses: number[] } {
    if (typeof error !== "object" || error === null || seen.has(error))
        return { messages: [], statuses: [] };
    seen.add(error);
    const nested =
        "cause" in error
            ? readDetails((error as { cause?: unknown }).cause, seen)
            : { messages: [], statuses: [] };
    const status =
        "status" in error && typeof (error as { status?: unknown }).status === "number"
            ? [(error as { status: number }).status]
            : [];
    const message =
        "message" in error && typeof (error as { message?: unknown }).message === "string"
            ? [(error as { message: string }).message]
            : [];
    return {
        messages: [...message, ...nested.messages],
        statuses: [...status, ...nested.statuses],
    };
}

export function isRetryableCodexStreamError(error: unknown): boolean {
    if (hasAbortError(error, new Set())) return false;
    return isRetryable(error, new Set());
}

function isRetryable(error: unknown, seen: Set<object>): boolean {
    const directive = readCodexErrorHeader(error, "x-should-retry")?.trim().toLowerCase();
    if (directive === "true") return true;
    if (directive === "false") return false;
    if (typeof error === "object" && error !== null) {
        if (seen.has(error)) return false;
        seen.add(error);
    }
    const status = numericProperty(error, "status");
    if (status !== undefined)
        return status === 408 || status === 409 || status === 429 || status >= 500;
    const code = stringProperty(error, "code") ?? stringProperty(error, "errno");
    if (code !== undefined && RETRYABLE_CODES.has(code.toUpperCase())) return true;
    const name = stringProperty(error, "name");
    if (name !== undefined && RETRYABLE_NAMES.has(name)) return true;
    const message = error instanceof Error ? error.message : "";
    if (RETRYABLE_MESSAGE.test(message)) return true;
    const cause =
        typeof error === "object" && error !== null && "cause" in error
            ? (error as { cause?: unknown }).cause
            : undefined;
    return cause !== undefined && isRetryable(cause, seen);
}

function hasAbortError(error: unknown, seen: Set<object>): boolean {
    if (isAbortError(error)) return true;
    if (typeof error !== "object" || error === null || seen.has(error)) return false;
    seen.add(error);
    return "cause" in error && hasAbortError((error as { cause?: unknown }).cause, seen);
}

const RETRYABLE_CODES = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
]);

const RETRYABLE_NAMES = new Set([
    "APIConnectionError",
    "APIConnectionTimeoutError",
    "TimeoutError",
    "WebSocketError",
]);

const RETRYABLE_MESSAGE =
    /\b(connection (?:closed|dropped|failed|lost|reset)|fetch failed|network error|socket (?:closed|disconnected|error|hang up)|stream (?:closed|disconnected)|timed? out|websocket (?:closed|disconnected|error))\b/i;

function isAbortError(error: unknown): boolean {
    return (
        (error instanceof DOMException && error.name === "AbortError") ||
        stringProperty(error, "name") === "AbortError"
    );
}

function numericProperty(error: unknown, property: string): number | undefined {
    if (typeof error !== "object" || error === null || !(property in error)) return undefined;
    const value = (error as Record<string, unknown>)[property];
    return typeof value === "number" ? value : undefined;
}

function stringProperty(error: unknown, property: string): string | undefined {
    if (typeof error !== "object" || error === null || !(property in error)) return undefined;
    const value = (error as Record<string, unknown>)[property];
    return typeof value === "string" ? value : undefined;
}

export function readCodexErrorHeader(error: unknown, name: string): string | undefined {
    return readHeader(error, name.toLowerCase(), new Set());
}

function readHeader(error: unknown, name: string, seen: Set<object>): string | undefined {
    if (typeof error !== "object" || error === null || seen.has(error)) return undefined;
    seen.add(error);
    if ("headers" in error) {
        const headers = (error as { headers?: unknown }).headers;
        if (typeof Headers !== "undefined" && headers instanceof Headers) {
            const value = headers.get(name);
            if (value !== null) return value;
        } else if (typeof headers === "object" && headers !== null) {
            const record = headers as Record<string, unknown>;
            const value =
                record[name] ??
                Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1];
            if (typeof value === "string") return value;
        }
    }
    return "cause" in error
        ? readHeader((error as { cause?: unknown }).cause, name, seen)
        : undefined;
}
