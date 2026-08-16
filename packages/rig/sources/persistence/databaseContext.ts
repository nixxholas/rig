import {
    createContextNamespace,
    registerContextExtension,
    type Context,
    type DerivedContext,
} from "@steve.kite/stdlib";

import type { DatabaseScope } from "./Transaction.js";
import {
    getSessionDatabaseOwner,
    isSessionDatabaseTransaction,
} from "./database/SessionDatabase.js";

declare global {
    namespace stdlib {
        interface ContextExtensions {
            readonly tx: DatabaseScope;
        }
    }
}

interface DatabaseContextState {
    readonly scope: ReturnType<typeof createContextNamespace<DatabaseScope | undefined>>;
}

// Vitest, development loaders, and plugin tooling can evaluate this module more than once in one
// process while stdlib's context-extension registry remains shared. Reuse both halves of the
// registration: keeping only the name would avoid the error but leave reloaded callers writing to
// a namespace that `ctx.tx` never reads.
const databaseContextRegistryKey = Symbol.for("@slopus/rig/database-context-registry/v1");
const existingDatabaseContextRegistry = Reflect.get(globalThis, databaseContextRegistryKey) as
    | WeakMap<object, DatabaseContextState>
    | undefined;
const databaseContextRegistry = existingDatabaseContextRegistry ?? new WeakMap();
if (existingDatabaseContextRegistry === undefined) {
    Reflect.set(globalThis, databaseContextRegistryKey, databaseContextRegistry);
}

const stdlibRegistryIdentity = registerContextExtension as object;
let databaseContextState = databaseContextRegistry.get(stdlibRegistryIdentity);
if (databaseContextState === undefined) {
    // Not detachable. The scope is whatever transaction the caller is in the middle of, and work
    // that detaches to a lifetime of its own outlives that commit, so it is handed no scope at all
    // and must be given the real database deliberately rather than writing through a finished one.
    const scope = createContextNamespace<DatabaseScope | undefined>("rig.sql.scope", undefined, {
        detachable: false,
    });
    registerContextExtension("tx", (ctx) => {
        const tx = scope.get(ctx);
        if (tx === undefined) throw new Error("Context has no database scope");
        return tx;
    });
    databaseContextState = { scope };
    databaseContextRegistry.set(stdlibRegistryIdentity, databaseContextState);
}
const databaseScope = databaseContextState.scope;

export function getDatabaseScope(ctx: Context): DatabaseScope | undefined {
    return databaseScope.get(ctx);
}

export function withDatabase<Source extends Context>(
    ctx: Source,
    tx: DatabaseScope,
): DerivedContext<Source> {
    const current = databaseScope.get(ctx);
    if (
        current !== undefined &&
        !isSessionDatabaseTransaction(current) &&
        !isSessionDatabaseTransaction(tx) &&
        getSessionDatabaseOwner(current) === getSessionDatabaseOwner(tx)
    ) {
        return ctx as unknown as DerivedContext<Source>;
    }
    return databaseScope.set(ctx, tx);
}

/** Derives a context whose SQL scope is the active transaction. */
export const withTransaction = withDatabase;
