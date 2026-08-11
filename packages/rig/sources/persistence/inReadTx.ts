import type { Context } from "@steve.kite/stdlib";

import { withDatabase } from "./databaseContext.js";
import {
    assertSessionDatabaseTransaction,
    currentSessionDatabaseTransaction,
    getSessionDatabaseOwner,
    isSessionDatabaseTransaction,
} from "./database/SessionDatabase.js";

/** Runs a multi-query persistence read against one coherent SQLite snapshot. */
export async function inReadTx<T>(
    ctx: Context,
    name: string,
    operation: (ctx: Context) => T | Promise<T>,
): Promise<T> {
    return await ctx.span(name, async (ctx) => {
        const tx = ctx.tx;
        if (isSessionDatabaseTransaction(tx)) {
            return await operation(withDatabase(ctx, assertSessionDatabaseTransaction(tx).facade));
        }

        const owner = getSessionDatabaseOwner(tx);
        if (owner === undefined) {
            throw new Error("The transaction is not associated with a SessionDatabase.");
        }
        const current = currentSessionDatabaseTransaction(owner);
        if (current !== undefined) return await operation(withDatabase(ctx, current.facade));
        return owner.runInReadTransaction(ctx, (ctx, transaction) =>
            operation(withDatabase(ctx, transaction)),
        );
    });
}
