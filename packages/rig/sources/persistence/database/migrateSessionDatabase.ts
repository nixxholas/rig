import { sql } from "drizzle-orm";

import type { SessionDatabase } from "./openSessionDatabase.js";
import { init } from "./migrations/01-init.js";

const migrations = [init] as const;
const SESSION_DATABASE_APPLICATION_ID = 0x52494732;

export const CURRENT_SESSION_DATABASE_VERSION = migrations.length;

export function migrateSessionDatabase(database: SessionDatabase): void {
    database.run(sql.raw("PRAGMA journal_mode = WAL"));
    database.run(sql.raw("PRAGMA synchronous = FULL"));
    database.run(sql.raw("PRAGMA busy_timeout = 5000"));
    database.run(sql.raw("PRAGMA foreign_keys = OFF"));
    try {
        database.transaction(
            (transaction) => {
                const applicationId =
                    transaction.get<{ application_id: number }>(sql.raw("PRAGMA application_id"))
                        ?.application_id ?? 0;
                let currentVersion =
                    transaction.get<{ user_version: number }>(sql.raw("PRAGMA user_version"))
                        ?.user_version ?? 0;
                if (applicationId !== SESSION_DATABASE_APPLICATION_ID) {
                    resetDatabase(transaction);
                    currentVersion = 0;
                } else if (currentVersion > CURRENT_SESSION_DATABASE_VERSION) {
                    throw new Error(
                        `The session database uses schema version ${String(currentVersion)}, but this Rig version supports up to ${String(CURRENT_SESSION_DATABASE_VERSION)}.`,
                    );
                }
                for (let version = currentVersion; version < migrations.length; version += 1) {
                    migrations[version]!(transaction);
                    transaction.run(sql.raw(`PRAGMA user_version = ${String(version + 1)}`));
                }
                transaction.run(
                    sql.raw(`PRAGMA application_id = ${String(SESSION_DATABASE_APPLICATION_ID)}`),
                );
            },
            { behavior: "immediate" },
        );
    } finally {
        database.run(sql.raw("PRAGMA foreign_keys = ON"));
    }
}

function resetDatabase(database: SessionDatabase): void {
    const tables = database.all<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"),
    );
    for (const table of tables) {
        database.run(sql.raw(`DROP TABLE ${quoteIdentifier(table.name)}`));
    }
    database.run(sql.raw("PRAGMA user_version = 0"));
}

function quoteIdentifier(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}
