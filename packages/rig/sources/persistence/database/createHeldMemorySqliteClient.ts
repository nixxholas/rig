import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";
import { _createClient as createSqliteClient } from "@libsql/client/sqlite3";

/**
 * Creates a named shared-cache database with one connection that never enters a transaction.
 *
 * The libSQL sqlite3 client detaches its primary connection when a transaction starts. Once the
 * transaction object is collected, that connection may become the last one keeping a named
 * in-memory database alive, which discards its schema before the client's next query. The keeper
 * connection preserves the database for exactly the returned client's lifetime.
 */
export function createHeldMemorySqliteClient(name: string): Client {
    const config = {
        authority: undefined,
        concurrency: 1,
        intMode: "number",
        path: `file:${name}-${randomUUID()}?mode=memory&cache=shared`,
        scheme: "file",
        tls: false,
    } as Parameters<typeof createSqliteClient>[0];
    const keeper = createSqliteClient(config);
    const client = createSqliteClient(config);
    const closeClient = client.close.bind(client);
    const closeKeeper = keeper.close.bind(keeper);
    let closed = false;

    Object.defineProperty(client, "close", {
        configurable: true,
        value: () => {
            if (closed) return;
            closed = true;
            const errors: unknown[] = [];
            try {
                closeClient();
            } catch (error) {
                errors.push(error);
            }
            try {
                closeKeeper();
            } catch (error) {
                errors.push(error);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
                throw new AggregateError(errors, "The in-memory SQLite clients could not close.");
            }
        },
        writable: true,
    });
    return client;
}
