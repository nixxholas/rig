import type {
    DrizzleSessionDatabase,
    DrizzleSessionTransaction,
    SessionDatabase,
} from "./database/SessionDatabase.js";

export type { DrizzleSessionDatabase, DrizzleSessionTransaction };

/**
 * The one database scope accepted by persistence operations.
 *
 * A scope may be the owning wrapper, its Drizzle database facade, or an active transaction.
 * `inDatabase` and `inTx` distinguish those cases at runtime and preserve transaction reuse.
 */
export type DatabaseScope = SessionDatabase | DrizzleSessionDatabase | DrizzleSessionTransaction;

/** Compatibility name for persistence helpers that still call their scope `TX`. */
export type TX = DatabaseScope;
