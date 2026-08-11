import { createRootContext } from "@steve.kite/stdlib";

import { asyncLock } from "../concurrency/index.js";

const lock = asyncLock({ reentry: "block" });
const lockContext = createRootContext().named("runtime-config");

/** Serializes every read-modify-write operation against Rig's machine-owned runtime config. */
export function runWithRuntimeConfigLock<T>(work: () => Promise<T>): Promise<T> {
    return lock.runInLock(lockContext, async () => await work());
}
