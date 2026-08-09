import { type DatabaseScope, type TX } from "./Transaction.js";
import {
    assertSessionDatabaseTransaction,
    currentSessionDatabaseTransaction,
    getSessionDatabaseOwner,
    isSessionDatabaseTransaction,
} from "./database/SessionDatabase.js";

export async function inTx<T>(
    tx: DatabaseScope,
    operation: (tx: TX) => T | Promise<T>,
): Promise<T> {
    if (isSessionDatabaseTransaction(tx)) {
        return await operation(assertSessionDatabaseTransaction(tx).facade);
    }

    const owner = getSessionDatabaseOwner(tx);
    if (owner === undefined) {
        throw new Error("The transaction is not associated with a SessionDatabase.");
    }
    const current = currentSessionDatabaseTransaction(owner);
    if (current !== undefined) return await operation(current.facade);
    return owner.runInLock((database) =>
        database.transaction(async (transaction) => operation(transaction), {
            behavior: "immediate",
        }),
    );
}
