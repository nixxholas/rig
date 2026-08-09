import type { DatabaseScope } from "../Transaction.js";
import type { DrizzleSessionDatabase, DrizzleSessionTransaction } from "./SessionDatabase.js";
import {
    assertSessionDatabaseTransaction,
    currentSessionDatabaseTransaction,
    getSessionDatabaseOwner,
    isSessionDatabaseTransaction,
    type SessionDatabase,
} from "./SessionDatabase.js";

export type SessionDatabaseOperation<T> = (
    tx: DrizzleSessionDatabase | DrizzleSessionTransaction,
) => T | Promise<T>;

/**
 * Runs one plain persistence operation under its connection lock.
 *
 * A transaction-scoped handle already owns the connection and therefore executes directly. A
 * wrapper or its raw Drizzle database uses the wrapper's lock, so nested persistence operations
 * do not accidentally open a second connection critical section.
 */
export async function inDatabase<T>(
    tx: DatabaseScope,
    operation: SessionDatabaseOperation<T>,
): Promise<T> {
    if (isSessionDatabaseTransaction(tx)) {
        return await operation(assertSessionDatabaseTransaction(tx).facade);
    }

    const owner = getSessionDatabaseOwner(tx as SessionDatabase | DrizzleSessionDatabase);
    if (owner === undefined) {
        throw new Error("The database operation is not associated with a SessionDatabase.");
    }
    const current = currentSessionDatabaseTransaction(owner);
    if (current !== undefined) return await operation(current.facade);
    return owner.runInLock((database) => Promise.resolve(operation(database)));
}
