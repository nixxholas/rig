import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { queryRigInstallationData } from "../queryRigInstallationData.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
    RIG_DATA_IDENTITY_SCHEMA_VERSION,
} from "../migrateSessionDatabase.js";
import { openSessionDatabase } from "../openSessionDatabase.js";
import { dropSchemaAddedAfterIdentityMigrations } from "./dropSchemaAddedAfterIdentityMigrations.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

const directories: string[] = [];
const root = createTestRootContext();

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("queryRigInstallationData", () => {
    it("reports absent data without creating its directory or database", async () => {
        const directory = testDirectory();
        const dataDirectory = join(directory, "rig-data");
        const databasePath = join(dataDirectory, "sessions.sqlite");

        expect(await queryRigInstallationData(root, databasePath)).toEqual({ status: "absent" });
        expect(existsSync(dataDirectory)).toBe(false);
    });

    it("distinguishes an existing uninitialized SQLite file", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "");

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            status: "uninitialized",
        });
    });

    it("reports a garbage non-SQLite file as unavailable instead of safely initializable", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "not a SQLite database");

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            message: expect.stringContaining("damaged"),
            reason: "unreadable",
            status: "unavailable",
        });
    });

    it("returns the same initialized epoch on every read and reopen", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "epoch-stable" });
        await opened.database.close(opened.ctx);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            epoch: "epoch-stable",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            epoch: "epoch-stable",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
    });

    it("creates a new epoch when a foreign data generation is atomically reset", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "epoch-before" });
        await opened.database.run(sql.raw("PRAGMA application_id = 0"));
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "epoch-after" });
        await opened.database.close(opened.ctx);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            epoch: "epoch-after",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
    });

    it("seeds one epoch when an existing Rig database receives the identity migration", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "discarded-epoch" });
        await dropSchemaAddedAfterIdentityMigrations(opened.database);
        await opened.database.run(
            sql.raw("ALTER TABLE rig_data_identity DROP COLUMN format_version"),
        );
        await opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(RIG_DATA_IDENTITY_SCHEMA_VERSION)}`),
        );
        await opened.database.close(opened.ctx);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            epoch: "discarded-epoch",
            schemaCompatibility: "upgrade_required",
            schemaVersion: RIG_DATA_IDENTITY_SCHEMA_VERSION,
            status: "initialized",
        });

        const upgraded = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(upgraded.ctx, {
            createDataEpoch: () => {
                throw new Error("Migration 17 must not be replayed.");
            },
        });
        await upgraded.database.close(upgraded.ctx);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            epoch: "discarded-epoch",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });
    });

    it("reports a current schema without its committed identity as damaged", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "missing-epoch" });
        await opened.database.run(sql.raw("DROP TABLE rig_data_identity"));
        await opened.database.close(opened.ctx);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            message: expect.stringContaining("damaged"),
            reason: "unreadable",
            status: "unavailable",
        });
    });

    it("reports an invalid committed identity as damaged", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "valid-epoch" });
        await opened.database.run(sql.raw("UPDATE rig_data_identity SET epoch = ''"));
        await opened.database.close(opened.ctx);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            message: expect.stringContaining("damaged"),
            reason: "unreadable",
            status: "unavailable",
        });
    });

    it("reports a structurally corrupt Rig schema as unavailable", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "corrupt-epoch" });
        await opened.database.close(opened.ctx);
        rmSync(`${databasePath}-wal`, { force: true });
        rmSync(`${databasePath}-shm`, { force: true });
        const descriptor = openSync(databasePath, "r+");
        writeSync(descriptor, Buffer.alloc(32, 0xff), 0, 32, 100);
        closeSync(descriptor);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            message: expect.stringContaining("input/output"),
            reason: "io_error",
            status: "unavailable",
        });
    });

    it("preserves the epoch while safely rejecting a newer schema", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "future-epoch" });
        await opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(CURRENT_SESSION_DATABASE_VERSION + 1)}`),
        );
        await opened.database.close(opened.ctx);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
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
    ] as const)("classifies %s as a stable %s result", async (code, reason) => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        writeFileSync(databasePath, "");

        const result = await queryRigInstallationData(root, databasePath, {
            openDatabase: async () => {
                throw Object.assign(new Error("inspection failed"), { code });
            },
        });

        expect(result).toEqual({
            message: expect.any(String),
            reason,
            status: "unavailable",
        });
    });

    it("reads an initialized database while its WAL connection is active", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "hot-wal-epoch" });
        await opened.database.run(sql.raw("UPDATE projects SET updated_at_ms = updated_at_ms"));

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            epoch: "hot-wal-epoch",
            schemaCompatibility: "current",
            schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            status: "initialized",
        });

        await opened.database.close(opened.ctx);
    });

    it("documents SQLite sidecars created while inspecting a stopped WAL database", async () => {
        const directory = testDirectory();
        const databasePath = join(directory, "sessions.sqlite");
        const opened = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "cold-wal-epoch" });
        await opened.database.close(opened.ctx);
        expect(readdirSync(directory).sort()).toEqual([
            "sessions.sqlite",
            "sessions.sqlite-shm",
            "sessions.sqlite-wal",
        ]);

        expect(await queryRigInstallationData(root, databasePath)).toMatchObject({
            epoch: "cold-wal-epoch",
            status: "initialized",
        });
        expect(readdirSync(directory).sort()).toEqual([
            "sessions.sqlite",
            "sessions.sqlite-shm",
            "sessions.sqlite-wal",
        ]);
    });

    it("classifies a real invalid database path without leaking a SQLite stack", async () => {
        const databasePath = join(testDirectory(), "sessions.sqlite");
        mkdirSync(databasePath);

        expect(await queryRigInstallationData(root, databasePath)).toEqual({
            message: expect.any(String),
            reason: "unreadable",
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
