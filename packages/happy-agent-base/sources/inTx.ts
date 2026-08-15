import { AsyncLocalStorage } from "node:async_hooks";

import { registerContextExtension, withAfterCommit, type Context } from "@steve.kite/stdlib";

import { isAgentSQLiteDatabase, type AgentDatabase } from "./AgentDatabase.js";
import {
    agentDatabase,
    agentStorageTransaction,
    withAgentStorageTransaction,
    type AgentStorageTransactionContext,
} from "./AgentContexts.js";

/** Work whose database operations should share one outer Agent Storage transaction. */
export type AgentTransactionWork<Result> = (ctx: Context) => Result | PromiseLike<Result>;

declare global {
    namespace stdlib {
        interface ContextExtensions {
            readonly inTx: <Result>(work: AgentTransactionWork<Result>) => Promise<Awaited<Result>>;
        }
    }
}

const activeTransactions = new AsyncLocalStorage<AgentStorageTransactionContext>();

registerContextExtension(
    "inTx",
    (ctx) =>
        async <Result>(work: AgentTransactionWork<Result>): Promise<Awaited<Result>> =>
            await inTx(ctx, work),
);

/**
 * Run work inside the database transaction carried by `ctx`, or open the one outer transaction
 * for its root database. Nested calls reuse the current transaction; transaction concurrency
 * belongs to the Drizzle database and its driver.
 */
export async function inTx<Result>(
    ctx: Context,
    work: AgentTransactionWork<Result>,
): Promise<Awaited<Result>> {
    const carried = agentStorageTransaction(ctx);
    const ambient = activeTransactions.getStore();
    if (ambient !== undefined && !ambient.lifetime.aborted) {
        if (carried === ambient) return await work(ctx);
        throw new Error(
            "Work started inside an agent storage transaction must use that transaction's context.",
        );
    }
    if (carried !== undefined) {
        if (carried.lifetime.aborted) {
            throw new Error("The agent storage transaction carried by this context has ended.");
        }
        return await work(ctx);
    }

    const root = agentDatabase(ctx);
    if (root === undefined) {
        throw new Error("Context has no agent database.");
    }

    const commit = async (transactionCtx: Context): Promise<Awaited<Result>> => {
        let runAfterCommit!: () => Promise<void>;
        const result = await runDrizzleTransaction(root, async (database) => {
            const [afterCommitCtx, drain] = withAfterCommit(transactionCtx);
            runAfterCommit = drain;
            const lifetime = new AbortController();
            const state: AgentStorageTransactionContext = {
                database,
                root,
                lifetime: lifetime.signal,
            };
            const txCtx = withAgentStorageTransaction(afterCommitCtx, state);
            try {
                return await activeTransactions.run(state, async () => await work(txCtx));
            } finally {
                lifetime.abort();
            }
        });
        try {
            await runAfterCommit();
        } catch (error: unknown) {
            transactionCtx.log.warn("Agent storage committed, but post-commit work failed.", error);
        }
        return result;
    };

    return await commit(ctx);
}

async function runDrizzleTransaction<Result>(
    database: AgentDatabase,
    work: (database: AgentDatabase) => Promise<Result>,
): Promise<Result> {
    if (isAgentSQLiteDatabase(database)) {
        return await database.transaction(async (transaction) => await work(transaction));
    }
    return await database.transaction(async (transaction) => await work(transaction));
}
