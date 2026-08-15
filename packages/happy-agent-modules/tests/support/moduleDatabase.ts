import { DatabaseSync } from "node:sqlite";

import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import type { AgentDatabase, AgentModuleMigration } from "@slopus/happy-agent-base";
import { withAgentDatabase } from "@slopus/happy-agent-base";

export interface ModuleDatabase {
    readonly database: SqliteRemoteDatabase;
    readonly context: Context;
    readonly ready: Promise<void>;
    readonly close: () => void;
}

export function moduleDatabase(
    migrations: readonly AgentModuleMigration[],
    name: string,
): ModuleDatabase & { readonly database: AgentDatabase } {
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
    const context = withAgentDatabase(createRootContext().named(name), database);
    const ready = Promise.all(migrations.map(([, migrate]) => migrate(context, database))).then(
        () => undefined,
    );
    return {
        database,
        context,
        ready,
        close: () => sqlite.close(),
    } as ModuleDatabase & { readonly database: AgentDatabase };
}
