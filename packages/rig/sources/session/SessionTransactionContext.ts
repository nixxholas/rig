import { AsyncLocalStorage } from "node:async_hooks";

import type { DatabaseScope, TX } from "../persistence/Transaction.js";
import { inTx } from "../persistence/inTx.js";
import type { SessionDatabase } from "../persistence/database/openSessionDatabase.js";

interface TransactionState {
    readonly callbacks: Array<() => void | Promise<void>>;
    readonly database: SessionDatabase;
    readonly tx: TX;
    active: boolean;
}

const transactionStorage = new AsyncLocalStorage<TransactionState>();

export class SessionTransactionPostCommitError extends Error {
    readonly failures: readonly unknown[];

    constructor(failures: readonly unknown[]) {
        const cause =
            failures.length === 1
                ? failures[0]
                : new AggregateError(failures, "Multiple post-commit callbacks failed.");
        super("A post-commit callback failed after the database transaction committed.", { cause });
        this.name = "SessionTransactionPostCommitError";
        this.failures = [...failures];
    }
}

export function isSessionTransactionPostCommitError(
    error: unknown,
): error is SessionTransactionPostCommitError {
    return error instanceof SessionTransactionPostCommitError;
}

export function currentSessionTransaction(database?: SessionDatabase): TX | undefined {
    const state = transactionStorage.getStore();
    if (
        state === undefined ||
        !state.active ||
        (database !== undefined && state.database !== database)
    ) {
        return undefined;
    }
    return state.tx;
}

/**
 * Runs a callback now when there is no transaction, or queues it for the
 * enclosing transaction's commit. The returned promise always represents the
 * callback when it runs immediately; callers must await it.
 */
export function deferSessionTransactionCommit(
    callback: () => void | Promise<void>,
    database?: SessionDatabase,
): Promise<void> {
    const state = transactionStorage.getStore();
    if (
        state === undefined ||
        !state.active ||
        (database !== undefined && state.database !== database)
    ) {
        return runImmediately(callback, state !== undefined);
    }
    state.callbacks.push(callback);
    return Promise.resolve();
}

export async function runSessionTransaction<T>(
    database: SessionDatabase,
    operation: (tx: TX) => T | Promise<T>,
): Promise<T> {
    const existing = transactionStorage.getStore();
    if (existing?.active === true && existing.database === database) {
        return await operation(existing.tx);
    }

    let callbacks: Array<() => void | Promise<void>> = [];
    let transactionState: TransactionState | undefined;
    let result: T;
    try {
        result = await inTx(database, async (tx) => {
            const state: TransactionState = {
                active: true,
                callbacks: [],
                database,
                tx,
            };
            transactionState = state;
            callbacks = state.callbacks;
            return await transactionStorage.run(state, () => operation(tx));
        });
    } finally {
        if (transactionState !== undefined) transactionState.active = false;
    }
    const callbackFailures: unknown[] = [];
    for (const callback of callbacks) {
        try {
            await transactionStorage.exit(() => callback());
        } catch (error) {
            callbackFailures.push(error);
        }
    }
    if (callbackFailures.length > 0) {
        throw new SessionTransactionPostCommitError(callbackFailures);
    }
    return result;
}

export function sessionTransactionScope(database: SessionDatabase): DatabaseScope {
    return currentSessionTransaction(database) ?? database;
}

function runImmediately(
    callback: () => void | Promise<void>,
    leaveCurrentContext: boolean,
): Promise<void> {
    const invoke = (): Promise<void> => {
        try {
            return Promise.resolve(callback()).then(() => undefined);
        } catch (error) {
            return Promise.reject(error);
        }
    };
    return leaveCurrentContext ? transactionStorage.exit(invoke) : invoke();
}
