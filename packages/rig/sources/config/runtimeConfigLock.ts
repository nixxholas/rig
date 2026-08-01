import { asyncLock } from "../concurrency/index.js";

const lock = asyncLock();

/** Serializes every read-modify-write operation against Rig's machine-owned runtime config. */
export function runWithRuntimeConfigLock<T>(work: () => Promise<T>): Promise<T> {
    return lock.runInLock(work);
}
