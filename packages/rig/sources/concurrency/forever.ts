import { isAbortedError } from "./AbortedError.js";
import { backoff } from "./backoff.js";
import { delay } from "./delay.js";

export interface ForeverOptions {
    /** Pause between passes. */
    delay: number;
    /** Identifies the loop in logs and in a slow shutdown. */
    name: string;
    signal: AbortSignal;
    /** Wait before the first pass instead of running immediately. */
    delayFirst?: boolean;
    onError?: (error: unknown, attempt: number) => void;
}

/**
 * Runs the function over and over until the application stops: a loop with a
 * backoff inside it, an abort signal, and a delay between passes.
 *
 * The name is what a slow shutdown reports, so it should say which loop it is
 * in words a person can act on.
 *
 * The returned promise resolves when the loop has actually left, which is what
 * a shutdown handler waits for.
 */
export async function forever(options: ForeverOptions, work: () => Promise<void>): Promise<void> {
    try {
        if (options.delayFirst === true) await delay(options.delay, options.signal);
        while (!options.signal.aborted) {
            await backoff(work, {
                signal: options.signal,
                ...(options.onError === undefined ? {} : { onError: options.onError }),
            });
            await delay(options.delay, options.signal);
        }
    } catch (error) {
        // Shutting down is how this loop is meant to end; anything else is a
        // real fault and belongs to the caller.
        if (!isAbortedError(error)) throw error;
    }
}
