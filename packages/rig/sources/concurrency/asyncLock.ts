export interface AsyncLock {
    /** Runs the function while holding the lock, in the order callers arrived. */
    runInLock<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * The base concurrency primitive: one function at a time, in arrival order.
 *
 * A lock is almost always enough on its own — reach for one before considering
 * a semaphore or a hand-rolled promise chain.
 */
export function asyncLock(): AsyncLock {
    // Each caller chains onto the tail, so ordering falls out of the chain
    // itself and no queue of pending callbacks has to be maintained.
    let tail: Promise<unknown> = Promise.resolve();

    return {
        runInLock<T>(work: () => Promise<T>): Promise<T> {
            // The failure of one holder must not poison the chain for the next.
            const result = tail.then(work, work);
            tail = result.catch(() => undefined);
            return result;
        },
    };
}
