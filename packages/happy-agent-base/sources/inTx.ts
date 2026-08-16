import { AsyncLocalStorage } from "node:async_hooks";

import {
    asyncLock,
    registerContextExtension,
    withAfterCommit,
    type AsyncLock,
    type Context,
} from "@steve.kite/stdlib";

import {
    isAgentSQLiteDatabase,
    type AgentDatabase,
    type AgentSQLiteDatabase,
} from "./AgentDatabase.js";
import {
    agentDatabase,
    agentStorageTransaction,
    withAgentStorageTransaction,
    type AgentStorageTransactionContext,
} from "./AgentContexts.js";

/** Work whose database operations should share one outer Agent Storage transaction. */
export type AgentTransactionWork<Result> = (ctx: Context) => Result | PromiseLike<Result>;

interface AgentTransactionContextState {
    readonly activeTransactions: AsyncLocalStorage<AgentStorageTransactionContext>;
    readonly sqliteLocks: WeakMap<AgentSQLiteDatabase, AsyncLock>;
}

declare global {
    namespace stdlib {
        interface ContextExtensions {
            readonly inTx: <Result>(work: AgentTransactionWork<Result>) => Promise<Awaited<Result>>;
        }
    }
}

// Keep the extension, ambient transaction identity, and per-SQLite-database locks stable when a
// development loader or Vitest evaluates this module again in the same process.
const transactionContextRegistryKey = Symbol.for(
    "@slopus/happy-agent-base/transaction-context-registry/v1",
);
const existingTransactionContextRegistry = Reflect.get(
    globalThis,
    transactionContextRegistryKey,
) as WeakMap<object, AgentTransactionContextState> | undefined;
const transactionContextRegistry = existingTransactionContextRegistry ?? new WeakMap();
if (existingTransactionContextRegistry === undefined) {
    Reflect.set(globalThis, transactionContextRegistryKey, transactionContextRegistry);
}

const stdlibRegistryIdentity = registerContextExtension as object;
let transactionContextState = transactionContextRegistry.get(stdlibRegistryIdentity);
if (transactionContextState === undefined) {
    transactionContextState = {
        activeTransactions: new AsyncLocalStorage<AgentStorageTransactionContext>(),
        sqliteLocks: new WeakMap(),
    };
    registerContextExtension(
        "inTx",
        (ctx) =>
            async <Result>(work: AgentTransactionWork<Result>): Promise<Awaited<Result>> =>
                await inTx(ctx, work),
    );
    transactionContextRegistry.set(stdlibRegistryIdentity, transactionContextState);
}
const { activeTransactions, sqliteLocks } = transactionContextState;

/**
 * Run work inside the database transaction carried by `ctx`, or open the one outer transaction
 * for its root database. Nested calls reuse the current transaction. Independent SQLite work is
 * serialized per root facade; PostgreSQL concurrency remains owned by its driver.
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

    let runAfterCommit!: () => Promise<void>;
    const commit = async (transactionCtx: Context): Promise<Awaited<Result>> =>
        await runDrizzleTransaction(root, async (database) => {
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

    let result: Awaited<Result>;
    if (isAgentSQLiteDatabase(root)) {
        let lock = sqliteLocks.get(root);
        if (lock === undefined) {
            lock = asyncLock({ reentry: "block" });
            sqliteLocks.set(root, lock);
        }
        result = await lock.runInLock(ctx, commit);
    } else {
        result = await commit(ctx);
    }
    try {
        await runAfterCommit();
    } catch (error: unknown) {
        ctx.log.warn("Agent storage committed, but post-commit work failed.", error);
    }
    return result;
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
