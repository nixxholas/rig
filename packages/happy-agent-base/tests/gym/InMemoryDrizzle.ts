import { DatabaseSync } from "node:sqlite";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

/** A package-local, real in-memory SQLite database exposed through Drizzle's async proxy. */
export function inMemoryDrizzle(): {
    readonly database: SqliteRemoteDatabase;
    readonly close: () => void;
} {
    const sqlite = new DatabaseSync(":memory:");
    const database = drizzle(async (query, params, method) => {
        const statement = sqlite.prepare(query);
        if (method === "run") {
            statement.run(...params);
            return { rows: [] };
        }
        if (method === "get") {
            const row = statement.get(...params);
            return { rows: row === undefined ? [] : [row] };
        }
        if (method === "values") {
            statement.setReturnArrays(true);
            return { rows: statement.all(...params) };
        }
        return { rows: statement.all(...params) };
    });
    return { database, close: () => sqlite.close() };
}
