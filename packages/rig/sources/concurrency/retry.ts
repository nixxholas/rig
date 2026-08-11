import { backoff, type BackoffOptions } from "./backoff.js";

export interface RetryOptions extends Omit<BackoffOptions, "timeout"> {
    timeout?: number;
}

const DEFAULT_RETRY_TIMEOUT_MS = 30_000;

/** Bounded form of the stdlib-backed exponential retry. */
export function retry<T>(
    work: (attempt: number) => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    return backoff(work, { ...options, timeout: options.timeout ?? DEFAULT_RETRY_TIMEOUT_MS });
}
