export const ABORTED_BY_SIGNAL = Symbol("aborted_by_signal");

export async function raceWithAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T | typeof ABORTED_BY_SIGNAL> {
    if (signal === undefined) return promise;
    if (signal.aborted) return ABORTED_BY_SIGNAL;

    let resolveAbort = () => {};
    const aborted = new Promise<typeof ABORTED_BY_SIGNAL>((resolve) => {
        resolveAbort = () => resolve(ABORTED_BY_SIGNAL);
    });
    // The provider may reject after the abort wins the race. Observe that loser explicitly so
    // cancellation does not leak an unhandled rejection while preserving the original promise's
    // rejection for callers when it wins.
    void promise.catch(() => undefined);
    signal.addEventListener("abort", resolveAbort, { once: true });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        signal.removeEventListener("abort", resolveAbort);
    }
}
