import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { queryRigInstallationData } from "../queryRigInstallationData.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
    RIG_DATA_IDENTITY_SCHEMA_VERSION,
} from "../migrateSessionDatabase.js";
import { openSessionDatabase } from "../openSessionDatabase.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("queryRigInstallationData", () => {
    it("reports absent data without creating its directory or database", () => {
        const root = testDirectory();
        const dataDirectory = join(root, "rig-data");
        const databasePath = join(dataDirectory, "sessions.sqlite");

        expect(queryRigInstallationData(databasePath)).toEqual({ status: "absent" });
        expect(existsSync(dataDirectory)).toBe(false);
    });

    it("distinguishes an existing uninitialized SQLite file", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "");

        expect(queryRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });

    it("treats a foreign non-SQLite file as uninitialized", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "not a SQLite database");

        expect(queryRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });

    it("returns the same initialized epoch on every read and reopen", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "epoch-stable" });
        opened.client.close();

        expect(queryRigInstallationData(databasePath)).toEqual({
            epoch: "epoch-stable",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
        expect(queryRigInstallationData(databasePath)).toEqual({
            epoch: "epoch-stable",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
    });

    it("creates a new epoch when a foreign data generation is atomically reset", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "epoch-before" });
        opened.database.run(sql.raw("PRAGMA application_id = 0"));
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "epoch-after" });
        opened.client.close();

        expect(queryRigInstallationData(databasePath)).toEqual({
            epoch: "epoch-after",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
    });

    it("seeds one epoch when an existing Rig database receives the identity migration", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "discarded-epoch" });
        opened.database.run(sql.raw("ALTER TABLE rig_data_identity DROP COLUMN format_version"));
        opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(RIG_DATA_IDENTITY_SCHEMA_VERSION)}`),
        );
        opened.client.close();

        expect(queryRigInstallationData(databasePath)).toEqual({
            epoch: "discarded-epoch",
            schemaCompatibility: "upgrade_required",
            schemaVersion: RIG_DATA_IDENTITY_SCHEMA_VERSION,
            status: "initialized",
        });

        const upgraded = openSessionDatabase(databasePath);
        migrateSessionDatabase(upgraded.database, {
            createDataEpoch: () => {
                throw new Error("Migration 17 must not be replayed.");
            },
        });
        upgraded.client.close();

        expect(queryRigInstallationData(databasePath)).toEqual({
            epoch: "discarded-epoch",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
    });

    it("treats a current schema without its committed identity as uninitialized", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "missing-epoch" });
        opened.database.run(sql.raw("DROP TABLE rig_data_identity"));
        opened.client.close();

        expect(queryRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });

    it("treats an invalid committed identity as uninitialized", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "valid-epoch" });
        opened.database.run(sql.raw("UPDATE rig_data_identity SET epoch = ''"));
        opened.client.close();

        expect(queryRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });

    it("preserves the epoch while safely rejecting a newer schema", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "future-epoch" });
        opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(CURRENT_SESSION_DATABASE_VERSION + 1)}`),
        );
        opened.client.close();

        expect(queryRigInstallationData(databasePath)).toEqual({
            epoch: "future-epoch",
            message: expect.stringContaining("newer schema version"),
            reason: "newer_schema",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION + 1,
            status: "incompatible",
        });
    });

    it.each([
        ["SQLITE_BUSY", "busy"],
        ["SQLITE_BUSY_RECOVERY", "busy"],
        ["SQLITE_LOCKED_SHAREDCACHE", "busy"],
        ["SQLITE_CANTOPEN", "unreadable"],
        ["SQLITE_READONLY_DIRECTORY", "unreadable"],
        ["SQLITE_IOERR_READ", "io_error"],
    ] as const)("classifies %s as a stable %s result", (code, reason) => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "");

        const result = queryRigInstallationData(databasePath, {
            openDatabase: () => {
                throw new Database.SqliteError("inspection failed", code);
            },
        });

        expect(result).toEqual({
            message: expect.any(String),
            reason,
            status: "unavailable",
        });
    });

    it("reads an initialized database while its WAL connection is active", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "hot-wal-epoch" });
        opened.database.run(sql.raw("UPDATE projects SET updated_at_ms = updated_at_ms"));

        expect(queryRigInstallationData(databasePath)).toEqual({
            epoch: "hot-wal-epoch",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });

        opened.client.close();
    });

    it("documents SQLite sidecars created while inspecting a stopped WAL database", () => {
        const root = testDirectory();
        const databasePath = join(root, "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "cold-wal-epoch" });
        opened.client.close();
        expect(readdirSync(root)).toEqual(["sessions.sqlite"]);

        expect(queryRigInstallationData(databasePath)).toMatchObject({
            epoch: "cold-wal-epoch",
            status: "initialized",
        });
        expect(readdirSync(root).sort()).toEqual([
            "sessions.sqlite",
            "sessions.sqlite-shm",
            "sessions.sqlite-wal",
        ]);
    });

    it("classifies a real invalid database path without leaking a SQLite stack", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        mkdirSync(databasePath);

        expect(queryRigInstallationData(databasePath)).toEqual({
            message: expect.any(String),
            reason: "io_error",
            status: "unavailable",
        });
    });
});

function testDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "rig-installation-inspection-"));
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    return directory;
}
