import type { Context } from "@steve.kite/stdlib";

import { withDatabase } from "../databaseContext.js";
import type { DrizzleSessionDatabase } from "./SessionDatabase.js";
import {
    assertSessionDatabaseTransaction,
    currentSessionDatabaseTransaction,
    getSessionDatabaseOwner,
    isSessionDatabaseTransaction,
    type SessionDatabase,
} from "./SessionDatabase.js";

export type SessionDatabaseOperation<T> = (ctx: Context) => T | Promise<T>;

/**
 * Runs one plain persistence operation under its connection lock.
 *
 * A transaction-scoped handle already owns the connection and therefore executes directly. A
 * wrapper or its raw Drizzle database uses the wrapper's lock, so nested persistence operations
 * do not accidentally open a second connection critical section.
 */
export async function inDatabase<T>(
    ctx: Context,
    name: string,
    operation: SessionDatabaseOperation<T>,
): Promise<T> {
    return await ctx.span(name, async (ctx) => {
        const tx = ctx.tx;
        if (isSessionDatabaseTransaction(tx)) {
            return await operation(withDatabase(ctx, assertSessionDatabaseTransaction(tx).facade));
        }

        const owner = getSessionDatabaseOwner(tx as SessionDatabase | DrizzleSessionDatabase);
        if (owner === undefined) {
            throw new Error("The database operation is not associated with a SessionDatabase.");
        }
        const current = currentSessionDatabaseTransaction(owner);
        if (current !== undefined) return await operation(withDatabase(ctx, current.facade));
        return owner.runInLock(ctx, (ctx, database) =>
            Promise.resolve(operation(withDatabase(ctx, database))),
        );
    });
}
