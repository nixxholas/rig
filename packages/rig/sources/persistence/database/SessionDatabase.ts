import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@steve.kite/stdlib";

import type { Client } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import { asyncLock, type AsyncLock } from "../../concurrency/index.js";
import * as schema from "./schema.js";

export type DrizzleSessionDatabase = LibSQLDatabase<typeof schema>;
export type DrizzleSessionTransaction = Parameters<
    Parameters<DrizzleSessionDatabase["transaction"]>[0]
>[0];

type SessionDatabaseState = "open" | "closing" | "closed";

const owners = new WeakMap<object, SessionDatabaseOwner>();
const facades = new WeakMap<object, object>();
const transactionStates = new WeakMap<object, SessionDatabaseTransactionState>();
const transactionOwners = new WeakMap<object, SessionDatabaseOwner>();
const activeTransaction = new AsyncLocalStorage<SessionDatabaseTransactionState>();

export type SessionDatabaseTransactionErrorReason = "unknown" | "foreign" | "stale";

export class SessionDatabaseTransactionError extends Error {
    constructor(readonly reason: SessionDatabaseTransactionErrorReason) {
        super(
            reason === "unknown"
                ? "The database scope is not an owned SessionDatabase transaction."
                : reason === "foreign"
                  ? "The database transaction belongs to another SessionDatabase."
                  : "The SessionDatabase transaction is no longer active.",
        );
        this.name = "SessionDatabaseTransactionError";
    }
}

export interface SessionDatabaseTransactionState {
    readonly facade: DrizzleSessionTransaction;
    readonly owner: SessionDatabaseOwner;
    readonly parent: SessionDatabaseTransactionState | undefined;
    active: boolean;
}

/**
 * Owns the one libSQL connection used by a session database.
 *
 * Drizzle's database object remains available as `database` for persistence operations. The
 * wrapper is the owner that supplies the connection lock and the lifecycle boundary; operations
 * must enter through `inDatabase` or `inTx` when they begin outside a transaction.
 */
class SessionDatabaseOwner {
    readonly asyncLock: AsyncLock;
    private state: SessionDatabaseState = "open";
    private closePromise: Promise<void> | undefined;

    constructor(
        readonly client: Client,
        readonly database: DrizzleSessionDatabase,
    ) {
        this.asyncLock = asyncLock();
        owners.set(database, this);
    }

    get closing(): boolean {
        return this.state === "closing";
    }

    get closed(): boolean {
        return this.state === "closed";
    }

    /**
     * Closes the underlying client. The libSQL client currently exposes a synchronous close
     * method, but keeping this lifecycle method asynchronous gives callers one awaited boundary.
     */
    async close(ctx: Context): Promise<void> {
        return await ctx.span("rig.sql.database.close", async () => {
            if (this.state === "closed") return;
            if (this.closePromise !== undefined) return await this.closePromise;

            this.state = "closing";
            const closePromise = this.asyncLock.runInLock(async () => {
                try {
                    await this.client.close();
                } finally {
                    this.state = "closed";
                }
            });
            this.closePromise = closePromise;
            try {
                await closePromise;
            } catch (error) {
                // The state is terminal even when the underlying close reports an error. Clearing
                // the rejected promise makes later close calls idempotent while retaining this
                // caller's original failure.
                this.closePromise = undefined;
                throw error;
            }
        });
    }

    /**
     * Admits work only while the connection is open. Work already admitted before `close()` is
     * allowed to drain ahead of the close operation; callers arriving after closing starts fail.
     */
    async runInLock<T>(
        ctx: Context,
        operation: (ctx: Context, database: DrizzleSessionDatabase) => T | Promise<T>,
    ): Promise<T> {
        if (this.state !== "open") {
            throw new SessionDatabaseClosedError(this.state);
        }
        return this.asyncLock.runInLock(() => Promise.resolve(operation(ctx, this.database)));
    }

    /**
     * Runs a transaction on the owner's one SQLite connection.
     *
     * The local libSQL client's `transaction()` moves its current native
     * connection into a transaction handle and lazily opens another connection
     * afterward. That handle does not close the native connection after commit,
     * so it retains file descriptors until garbage collection. Since this owner
     * already serializes every operation, explicit transaction statements give
     * us the same isolation without rotating connections.
     */
    async runInTransaction<T>(
        ctx: Context,
        operation: (ctx: Context, transaction: DrizzleSessionTransaction) => T | Promise<T>,
    ): Promise<T> {
        return await this.runTransaction(ctx, "BEGIN IMMEDIATE", operation);
    }

    /**
     * Runs a coherent read snapshot without acquiring SQLite's writer reservation.
     *
     * WAL readers can proceed while another connection is writing. Starting every multi-query
     * read with `BEGIN IMMEDIATE` instead makes a harmless transcript request wait for the writer
     * timeout and turns that timeout into a daemon-fatal database error.
     */
    async runInReadTransaction<T>(
        ctx: Context,
        operation: (ctx: Context, transaction: DrizzleSessionTransaction) => T | Promise<T>,
    ): Promise<T> {
        return await this.runTransaction(ctx, "BEGIN", operation);
    }

    private async runTransaction<T>(
        ctx: Context,
        begin: "BEGIN" | "BEGIN IMMEDIATE",
        operation: (ctx: Context, transaction: DrizzleSessionTransaction) => T | Promise<T>,
    ): Promise<T> {
        return this.runInLock(ctx, async (ctx, database) => {
            await database.run(sql.raw(begin));
            const state = createTransactionState(this, database, activeTransaction.getStore());
            return await activeTransaction.run(state, async () => {
                try {
                    const result = await operation(ctx, state.facade);
                    await database.run(sql.raw("COMMIT"));
                    return result;
                } catch (error) {
                    try {
                        await database.run(sql.raw("ROLLBACK"));
                    } catch (rollbackError) {
                        throw new AggregateError(
                            [error, rollbackError],
                            "SQLite transaction failed and rollback also failed.",
                        );
                    }
                    throw error;
                } finally {
                    state.active = false;
                }
            });
        });
    }
}

export class SessionDatabaseClosedError extends Error {
    readonly state: Exclude<SessionDatabaseState, "open">;

    constructor(state: Exclude<SessionDatabaseState, "open">) {
        super(`The session database is ${state}.`);
        this.name = "SessionDatabaseClosedError";
        this.state = state;
    }
}

/**
 * Historical migration modules and the persistence operations use the Drizzle database facade as
 * their `tx` type. The runtime wrapper delegates that facade while adding ownership metadata.
 */
/**
 * The owner is also exposed as a Drizzle database facade through the proxy returned by
 * `createSessionDatabase`. Keep that intersection as a type alias instead of merging a class and
 * interface, which hides initialization mistakes from TypeScript's declaration-merging checks.
 */
export type SessionDatabase = SessionDatabaseOwner & DrizzleSessionDatabase;

export const SessionDatabase = SessionDatabaseOwner;

export type DrizzleSessionTx = DrizzleSessionDatabase | DrizzleSessionTransaction;

export function getSessionDatabaseOwner(value: unknown): SessionDatabaseOwner | undefined {
    if (!isObject(value)) return undefined;
    return (
        owners.get(value) ??
        transactionOwners.get(value) ??
        (value instanceof SessionDatabaseOwner ? value : undefined)
    );
}

export function isSessionDatabaseTransaction(value: unknown): value is DrizzleSessionTransaction {
    return isObject(value) && transactionStates.has(value);
}

export function assertSessionDatabaseTransaction(value: unknown): SessionDatabaseTransactionState {
    if (!isObject(value)) throw new SessionDatabaseTransactionError("unknown");
    const state = transactionStates.get(value);
    if (state === undefined) throw new SessionDatabaseTransactionError("unknown");
    if (!state.active) throw new SessionDatabaseTransactionError("stale");

    const current = activeTransaction.getStore();
    if (!transactionScopeContains(current, state)) {
        throw new SessionDatabaseTransactionError("foreign");
    }
    return state;
}

/**
 * Checks whether an operation targeting `owner` is nested in an active transaction. A nested
 * operation on that owner reuses the transaction; a plain scope for another owner remains
 * independent and may acquire its own lock. Foreign or stale transaction handles are rejected by
 * `assertSessionDatabaseTransaction`.
 */
export function currentSessionDatabaseTransaction(
    owner: SessionDatabaseOwner,
): SessionDatabaseTransactionState | undefined {
    let current = activeTransaction.getStore();
    while (current !== undefined) {
        if (current.active && current.owner === owner) return current;
        current = current.parent;
    }
    return undefined;
}

export function createSessionDatabase(client: Client): SessionDatabase {
    const rawDatabase = drizzle(client, { schema });
    const database = wrapDrizzleFacade(rawDatabase);
    const owner = new SessionDatabaseOwner(client, database);
    owners.set(rawDatabase, owner);
    owners.set(database, owner);
    const wrapper = new Proxy(owner, {
        get(target, property, receiver) {
            if (property in target) return Reflect.get(target, property, receiver);
            const value = Reflect.get(database, property, database);
            return typeof value === "function" ? value.bind(database) : value;
        },
    });
    owners.set(wrapper, owner);
    return wrapper as SessionDatabase;
}

/**
 * Drizzle's libSQL adapter currently attempts to normalize an absent row in `get()` and throws
 * while reading `undefined`. The synchronous SQLite facade returned `undefined`, which is the
 * contract used by persistence operations, so keep that behavior at the database boundary.
 */
export function wrapDrizzleFacade<T extends object>(database: T, guard?: () => void): T {
    const existing = facades.get(database);
    if (existing !== undefined) return existing as T;

    const facade = new Proxy(database, {
        get(target, property, receiver) {
            guard?.();
            if (property === "get") {
                const all = Reflect.get(target, "all", target) as (
                    ...args: unknown[]
                ) => Promise<unknown[]>;
                return (...args: unknown[]) => {
                    guard?.();
                    return all.apply(target, args).then((rows) => rows[0]);
                };
            }
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
                guard?.();
                if (property === "transaction" && typeof args[0] === "function") {
                    const callback = args[0] as (transaction: object) => unknown;
                    const owner =
                        getSessionDatabaseOwner(
                            target as SessionDatabase | DrizzleSessionDatabase,
                        ) ?? transactionOwners.get(target);
                    args[0] = async (transaction: object) => {
                        if (owner === undefined) {
                            throw new SessionDatabaseTransactionError("unknown");
                        }
                        const facade = wrapDrizzleFacade(transaction);
                        const state: SessionDatabaseTransactionState = {
                            active: true,
                            facade: facade as DrizzleSessionTransaction,
                            owner,
                            parent: activeTransaction.getStore(),
                        };
                        registerTransactionScope(transaction, facade, state);
                        return await activeTransaction.run(state, async () => {
                            try {
                                return await callback(facade);
                            } finally {
                                state.active = false;
                            }
                        });
                    };
                }
                const result = value.apply(target, args);
                return wrapQueryBuilder(result, guard);
            };
        },
    });
    facades.set(database, facade);
    facades.set(facade, facade);
    return facade;
}

/**
 * Drizzle exposes a raw transaction object to its callback while Rig hands callers a wrapped
 * facade. Register both identities before entering user code so nested persistence helpers can
 * recover the same owner regardless of which representation they receive.
 */
function registerTransactionScope(
    rawTransaction: object,
    facade: object,
    state: SessionDatabaseTransactionState,
): void {
    transactionStates.set(rawTransaction, state);
    transactionStates.set(facade, state);
    transactionOwners.set(rawTransaction, state.owner);
    transactionOwners.set(facade, state.owner);
    owners.set(rawTransaction, state.owner);
    owners.set(facade, state.owner);
}

function createTransactionState(
    owner: SessionDatabaseOwner,
    database: DrizzleSessionDatabase,
    parent: SessionDatabaseTransactionState | undefined,
): SessionDatabaseTransactionState {
    // A distinct facade gives the transaction a scope identity without opening
    // another database connection. It also makes retained contexts reliably
    // stale after this operation finishes instead of looking like the owner's
    // always-live database facade.
    let state!: SessionDatabaseTransactionState;
    const guard = () => assertActiveTransactionState(state);
    const transaction = new Proxy(database, {
        get(target, property, receiver) {
            guard();
            if (property === "$client") return undefined;
            return Reflect.get(target, property, receiver);
        },
        has(target, property) {
            guard();
            return property === "$client" ? false : Reflect.has(target, property);
        },
    });
    const facade = wrapDrizzleFacade(transaction, guard) as unknown as DrizzleSessionTransaction;
    state = { active: true, facade, owner, parent };
    registerTransactionScope(transaction, facade, state);
    return state;
}

function assertActiveTransactionState(state: SessionDatabaseTransactionState): void {
    if (!state.active) throw new SessionDatabaseTransactionError("stale");
    if (!transactionScopeContains(activeTransaction.getStore(), state)) {
        throw new SessionDatabaseTransactionError("foreign");
    }
}

function transactionScopeContains(
    current: SessionDatabaseTransactionState | undefined,
    expected: SessionDatabaseTransactionState,
): boolean {
    while (current !== undefined) {
        if (current === expected) return true;
        current = current.parent;
    }
    return false;
}

function isObject(value: unknown): value is object {
    return typeof value === "object" && value !== null;
}

function wrapQueryBuilder<T>(value: T, guard?: () => void): T {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        value instanceof Promise
    ) {
        return value;
    }
    // A transaction-scoped builder must remain guarded from the moment it is created. Several
    // Drizzle builders do not expose `get` until a later method such as `from`, so waiting for that
    // marker would let the initial builder escape and manufacture unguarded work after commit.
    if (guard !== undefined) return wrapDrizzleFacade(value as object, guard) as T;
    if (!("get" in value)) return value;
    return wrapDrizzleFacade(value as object, guard) as T;
}
