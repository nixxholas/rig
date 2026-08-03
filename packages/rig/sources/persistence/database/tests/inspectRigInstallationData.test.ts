import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { inspectRigInstallationData } from "../inspectRigInstallationData.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../migrateSessionDatabase.js";
import { openSessionDatabase } from "../openSessionDatabase.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("inspectRigInstallationData", () => {
    it("reports absent data without creating its directory or database", () => {
        const root = testDirectory();
        const dataDirectory = join(root, "rig-data");
        const databasePath = join(dataDirectory, "sessions.sqlite");

        expect(inspectRigInstallationData(databasePath)).toEqual({ status: "absent" });
        expect(existsSync(dataDirectory)).toBe(false);
    });

    it("distinguishes an existing uninitialized SQLite file", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "");

        expect(inspectRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });

    it("treats a foreign non-SQLite file as uninitialized", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "not a SQLite database");

        expect(inspectRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });

    it("returns the same initialized epoch on every read and reopen", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "epoch-stable" });
        opened.client.close();

        expect(inspectRigInstallationData(databasePath)).toEqual({
            epoch: "epoch-stable",
            status: "initialized",
        });
        expect(inspectRigInstallationData(databasePath)).toEqual({
            epoch: "epoch-stable",
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

        expect(inspectRigInstallationData(databasePath)).toEqual({
            epoch: "epoch-after",
            status: "initialized",
        });
    });

    it("seeds one epoch when an existing Rig database receives the identity migration", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "discarded-epoch" });
        opened.database.run(sql.raw("DROP TABLE rig_data_identity"));
        opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(CURRENT_SESSION_DATABASE_VERSION - 1)}`),
        );
        opened.client.close();

        expect(inspectRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });

        const upgraded = openSessionDatabase(databasePath);
        migrateSessionDatabase(upgraded.database, { createDataEpoch: () => "upgraded-epoch" });
        upgraded.client.close();

        expect(inspectRigInstallationData(databasePath)).toEqual({
            epoch: "upgraded-epoch",
            status: "initialized",
        });
    });

    it("treats a current schema without its committed identity as uninitialized", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "missing-epoch" });
        opened.database.run(sql.raw("DROP TABLE rig_data_identity"));
        opened.client.close();

        expect(inspectRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });

    it("treats an invalid committed identity as uninitialized", () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = openSessionDatabase(databasePath);
        migrateSessionDatabase(opened.database, { createDataEpoch: () => "valid-epoch" });
        opened.database.run(sql.raw("UPDATE rig_data_identity SET epoch = ''"));
        opened.client.close();

        expect(inspectRigInstallationData(databasePath)).toEqual({ status: "uninitialized" });
    });
});

function testDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "rig-installation-inspection-"));
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    return directory;
}
