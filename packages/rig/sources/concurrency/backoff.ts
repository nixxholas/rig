import {
    backoff as retryWithBackoff,
    createRootContext,
    withLifetime,
} from "@steve.kite/stdlib";

export interface BackoffOptions {
    initialDelay?: number;
    maxDelay?: number;
    timeout?: number;
    signal?: AbortSignal;
    onError?: (error: unknown, attempt: number) => void;
    now?: () => number;
}

/** Context-adapted stdlib exponential backoff. */
export async function backoff<T>(
    work: (attempt: number) => Promise<T>,
    options: BackoffOptions = {},
): Promise<T> {
    const ctx =
        options.signal === undefined
            ? createRootContext()
            : withLifetime(createRootContext(), options.signal);
    return await retryWithBackoff(
        ctx,
        async (_ctx, attempt) => await work(attempt),
        {
            ...(options.initialDelay === undefined ? {} : { initialDelay: options.initialDelay }),
            ...(options.maxDelay === undefined ? {} : { maxDelay: options.maxDelay }),
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
            ...(options.now === undefined ? {} : { now: options.now }),
            ...(options.onError === undefined
                ? {}
                : { onError: (_ctx: unknown, error: unknown, attempt: number) => options.onError!(error, attempt) }),
        },
    );
}
