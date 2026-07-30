import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../migrateSessionDatabase.js";
import { openSessionDatabase } from "../openSessionDatabase.js";
import * as schema from "../schema.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("migrateSessionDatabase", () => {
    it("creates the complete schema from the init migration", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database);

        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });
        expect(
            opened.database
                .all<{ name: string }>(
                    sql.raw(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                    ),
                )
                .map((row) => row.name),
        ).toEqual(
            Object.values(schema)
                .map((table) => getTableConfig(table).name)
                .sort(),
        );

        opened.client.close();
    });

    it("keeps an initialized database unchanged on later starts", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database);
        migrateSessionDatabase(opened.database);

        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });

        opened.client.close();
    });

    it("atomically replaces a database from the previous migration generation", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("CREATE TABLE legacy_data (value TEXT NOT NULL)"));
        opened.database.run(sql.raw("INSERT INTO legacy_data (value) VALUES ('discard me')"));
        opened.database.run(sql.raw("PRAGMA user_version = 13"));

        migrateSessionDatabase(opened.database);

        expect(
            opened.database.get(
                sql.raw("SELECT name FROM sqlite_master WHERE name = 'legacy_data'"),
            ),
        ).toBeUndefined();
        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({ user_version: 1 });

        opened.client.close();
    });

    it("keeps the init migration atomic", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        opened.database.run(sql.raw("CREATE TABLE project_avatar_assets (hash TEXT PRIMARY KEY)"));

        expect(() => migrateSessionDatabase(opened.database)).toThrow();
        expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({ user_version: 0 });
        expect(
            opened.database
                .all<{ name: string }>(
                    sql.raw(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                    ),
                )
                .map((row) => row.name),
        ).toEqual(["project_avatar_assets"]);

        opened.client.close();
    });

    it("rejects a database created by an unknown future schema", () => {
        const opened = openTestDatabase();
        opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(CURRENT_SESSION_DATABASE_VERSION + 1)}`),
        );

        expect(() => migrateSessionDatabase(opened.database)).toThrow(/supports up to 1/u);

        opened.client.close();
    });

    it("keeps the Drizzle schema identical to the init migration", () => {
        const opened = openTestDatabase();
        migrateSessionDatabase(opened.database);

        for (const table of Object.values(schema)) {
            const config = getTableConfig(table);
            const actualColumns = opened.database.all<{
                name: string;
                notnull: number;
                pk: number;
            }>(sql.raw(`PRAGMA table_info(${config.name})`));
            expect(actualColumns.map((column) => column.name)).toEqual(
                config.columns.map((column) => column.name),
            );
            for (const column of config.columns) {
                const actual = actualColumns.find((candidate) => candidate.name === column.name);
                expect(actual, `${config.name}.${column.name}`).toBeDefined();
                if (column.notNull) {
                    expect(
                        actual!.notnull === 1 ||
                            (actual!.pk > 0 && column.getSQLType() === "integer"),
                        `${config.name}.${column.name} must be NOT NULL`,
                    ).toBe(true);
                }
            }
        }

        opened.client.close();
    });
});

function openTestDatabase() {
    const directory = mkdtempSync(join(tmpdir(), "rig-database-init-"));
    directories.push(directory);
    return openSessionDatabase(join(directory, "sessions.sqlite"));
}
