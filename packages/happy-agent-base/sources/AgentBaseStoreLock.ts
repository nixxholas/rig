import { asyncLock, type AsyncLock, type Context } from "@steve.kite/stdlib";

import type { AgentPersistence } from "./AgentPersistence.js";

/** Every lock handed out for a store, so `agentBaseWithStoreStill` can find and hold them all. */
const owners = new WeakMap<AgentPersistence, AsyncLock[]>();

/**
 * A fresh lock for one owner of a store, remembered as belonging to that store. Two owners over
 * one store are genuinely concurrent — that is what makes the store, rather than any one owner's
 * memory, the authority — so each gets its own lock and neither waits for the other.
 */
export function agentBaseStoreLock(persistence: AgentPersistence): AsyncLock {
    const created = asyncLock({ reentry: "block" });
    const existing = owners.get(persistence);
    if (existing === undefined) {
        owners.set(persistence, [created]);
    } else {
        existing.push(created);
    }
    return created;
}

/**
 * Run work with every owner of a store holding still. This is for the questions asked about a
 * store from outside it — whether it owes work, or erasing it once its identity is gone — where
 * a half-applied step of some owner would be read as a whole one. Owners only ever take their
 * own lock, so taking all of them in one fixed order cannot deadlock against them.
 */
export async function agentBaseWithStoreStill<Result>(
    ctx: Context,
    persistence: AgentPersistence,
    work: (ctx: Context) => Promise<Result>,
): Promise<Result> {
    const held = [...(owners.get(persistence) ?? [])];
    /** Take the next lock in `held` and recurse, running `work` once every owner is held. */
    const enter = async (index: number, entered: Context): Promise<Result> => {
        const lock = held[index];
        if (lock === undefined) return await work(entered);
        return await lock.runInLock(entered, (lockCtx) => enter(index + 1, lockCtx));
    };
    return await enter(0, ctx);
}
