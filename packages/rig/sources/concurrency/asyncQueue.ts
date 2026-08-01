import { asyncLock, type AsyncLock } from "./asyncLock.js";

export type AsyncQueue = AsyncLock;

/**
 * A queue, which is the same thing as a lock: holding a lock in arrival order
 * already gives the ordering a queue promises.
 *
 * Both names exist because at a call site one of the two words is usually the
 * honest description of what the code is doing.
 */
export function asyncQueue(): AsyncQueue {
    return asyncLock();
}
