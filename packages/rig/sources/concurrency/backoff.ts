import { isAbortedError, throwIfAborted } from "./AbortedError.js";
import { delay } from "./delay.js";

export interface BackoffOptions {
    /** First pause after a failure. Defaults to 500ms. */
    initialDelay?: number;
    /** Upper bound on the pause. Defaults to one minute. */
    maxDelay?: number;
    /** Give up after this long. Unbounded by default. */
    timeout?: number;
    signal?: AbortSignal;
    /** Called on each failure, for logging. */
    onError?: (error: unknown, attempt: number) => void;
    now?: () => number;
}

const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 60_000;

/**
 * Runs the function with exponential backoff until it succeeds.
 *
 * A backoff is infinite by default: it keeps trying until the work succeeds or
 * the program starts shutting down. An abort always wins immediately, and a
 * `timeout` turns this into the bounded form that `retry` exposes.
 */
export async function backoff<T>(
    work: (attempt: number) => Promise<T>,
    options: BackoffOptions = {},
): Promise<T> {
    const now = options.now ?? Date.now;
    const maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY_MS;
    const deadline = options.timeout === undefined ? undefined : now() + options.timeout;
    let wait = options.initialDelay ?? DEFAULT_INITIAL_DELAY_MS;

    for (let attempt = 1; ; attempt += 1) {
        throwIfAborted(options.signal);
        try {
            return await work(attempt);
        } catch (error) {
            // Abort is not a failure to retry through; it means stop now.
            if (isAbortedError(error) || options.signal?.aborted === true) throw error;
            options.onError?.(error, attempt);

            // A bounded backoff reports the last real failure, not a timeout of
            // its own, because that is what a caller needs to diagnose.
            if (deadline !== undefined && now() + wait >= deadline) throw error;

            await delay(wait, options.signal);
            wait = Math.min(wait * 2, maxDelay);
        }
    }
}
