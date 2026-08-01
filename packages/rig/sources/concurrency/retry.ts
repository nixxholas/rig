import { backoff, type BackoffOptions } from "./backoff.js";

export interface RetryOptions extends Omit<BackoffOptions, "timeout"> {
    /** How long to keep trying before giving up. Defaults to 30 seconds. */
    timeout?: number;
}

const DEFAULT_RETRY_TIMEOUT_MS = 30_000;

/**
 * A backoff bounded by time. When the work has still not succeeded once the
 * time runs out, the failure is thrown rather than swallowed.
 */
export function retry<T>(
    work: (attempt: number) => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    return backoff(work, { ...options, timeout: options.timeout ?? DEFAULT_RETRY_TIMEOUT_MS });
}
