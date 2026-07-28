import type { DatabaseSync } from "node:sqlite";

export interface SessionDatabaseMigration {
    readonly version: number;
    prepare(database: DatabaseSync): void;
    apply(database: DatabaseSync): void;
}
