import type { Context } from "@steve.kite/stdlib";

import { inTx } from "../inTx.js";
import { inDatabase } from "./inDatabase.js";
import type { SessionDatabase } from "./SessionDatabase.js";
import { withDatabase } from "../databaseContext.js";

/** Stateless query/transaction boundary for product services backed by Rig's SQLite database. */
export class SqliteServiceDatabase {
    readonly #database: SessionDatabase;

    constructor(database: SessionDatabase) {
        this.#database = database;
    }

    async query<Result>(
        ctx: Context,
        operation: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await inDatabase(
            withDatabase(ctx, this.#database),
            "rig.sql.service.query",
            operation,
        );
    }

    async transaction<Result>(
        ctx: Context,
        operation: (ctx: Context) => Promise<Result>,
    ): Promise<Result> {
        return await inTx(
            withDatabase(ctx, this.#database),
            "rig.sql.service.transaction",
            operation,
        );
    }
}
