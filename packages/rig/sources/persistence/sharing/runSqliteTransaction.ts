export interface SqliteTransactionHandle {
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): void;
}

/**
 * Commits one SQLite transaction and preserves the operation or commit failure when cleanup also
 * fails. The handle's close is always attempted exactly once.
 */
export async function runSqliteTransaction<Result>(
    ctx: Context,
    handle: SqliteTransactionHandle,
    operation: () => Promise<Result>,
): Promise<Result> {
    return await ctx.span("rig.sql.sharing.transaction", async () =>
        runSqliteTransactionBody(handle, operation),
    );
}

export async function runSqliteTransactionBody<Result>(
    handle: SqliteTransactionHandle,
    operation: () => Promise<Result>,
): Promise<Result> {
    let result!: Result;
    let failed = false;
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];

    try {
        result = await operation();
        await handle.commit();
    } catch (error) {
        failed = true;
        primaryError = error;
        try {
            await handle.rollback();
        } catch (rollbackError) {
            cleanupErrors.push(rollbackError);
        }
    } finally {
        try {
            handle.close();
        } catch (closeError) {
            cleanupErrors.push(closeError);
        }
    }

    if (failed) {
        if (cleanupErrors.length > 0) {
            throw new AggregateError(
                [primaryError, ...cleanupErrors],
                "SQLite transaction failed and cleanup also failed.",
            );
        }
        throw primaryError;
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "SQLite transaction cleanup failed.");
    }
    return result;
}
import type { Context } from "@steve.kite/stdlib";
