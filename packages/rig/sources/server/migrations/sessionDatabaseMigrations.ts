import type { DatabaseSync } from "node:sqlite";

import { migration12 } from "./12/migration.js";
import type { SessionDatabaseMigration } from "./SessionDatabaseMigration.js";

const migrations: readonly SessionDatabaseMigration[] = [migration12];

export const CURRENT_SESSION_DATABASE_VERSION = 13;

export function prepareSessionDatabaseMigrations(
    database: DatabaseSync,
    currentVersion: number,
): void {
    for (const migration of migrations) {
        if (migration.version > currentVersion) migration.prepare(database);
    }
}

export function applySessionDatabaseMigrations(database: DatabaseSync): void {
    for (const migration of migrations) migration.apply(database);
}
