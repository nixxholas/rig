import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
    RigCliInstallationInspection,
    RigInstallationData,
} from "../protocol/InstallationProtocol.js";
import {
    migrateSessionDatabase,
    RIG_DATA_IDENTITY_MIGRATION_INDEX,
} from "../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { sql } from "drizzle-orm";
import {
    formatRigInspection,
    rigInspectionExitCode,
    runRigInspection,
} from "./runRigInspection.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("runRigInspection", () => {
    it("prints stable machine-readable clean-install facts without creating daemon state", async () => {
        const root = testDirectory();
        const daemonDirectory = join(root, "daemon");
        const databasePath = join(daemonDirectory, "sessions.sqlite");
        const output: string[] = [];

        const inspection = await runRigInspection({
            databasePath,
            json: true,
            log: (line) => output.push(line),
            rigVersion: "1.2.3",
        });

        expect(inspection).toEqual({
            cliProtocolVersion: expect.any(Number),
            cliVersion: "1.2.3",
            data: { status: "absent" },
            formatVersion: 1,
            source: "cli",
        });
        expect(JSON.parse(output[0]!)).toEqual(inspection);
        expect(existsSync(daemonDirectory)).toBe(false);
    });

    it("prints initialized data and its stable epoch in human-readable English", async () => {
        const root = testDirectory();
        const databasePath = join(root, "sessions.sqlite");
        const database = await openSessionDatabase(databasePath);
        await migrateSessionDatabase(database.database, { createDataEpoch: () => "epoch-one" });
        await database.client.close();
        const output: string[] = [];

        await runRigInspection({
            databasePath,
            log: (line) => output.push(line),
            rigVersion: "1.2.3",
        });

        expect(output).toEqual([
            "Installed Rig CLI version: 1.2.3",
            expect.stringMatching(/^Installed Rig CLI protocol version: \d+$/u),
            "Rig data is initialized.",
            "Rig data epoch: epoch-one",
            expect.stringMatching(/^Rig data schema version: \d+$/u),
        ]);
    });

    it("reports a populated released v16 database as a recognized epoch-less upgrade", async () => {
        const root = testDirectory();
        const databasePath = join(root, "sessions.sqlite");
        const store = await PersistentSessionStore.open({ databasePath });
        await store.create({ cwd: root });
        await store.close();
        const database = await openSessionDatabase(databasePath);
        expect(
            await database.database.get<{ count: number }>(
                sql.raw("SELECT COUNT(*) AS count FROM sessions"),
            ),
        ).toEqual({ count: 1 });
        await database.database.run(sql.raw("DROP TABLE rig_data_identity"));
        await database.database.run(
            sql.raw(`PRAGMA user_version = ${String(RIG_DATA_IDENTITY_MIGRATION_INDEX)}`),
        );
        await database.client.close();
        const output: string[] = [];

        const result = await runRigInspection({
            databasePath,
            log: (line) => output.push(line),
            rigVersion: "1.2.3",
        });

        expect(result.data).toEqual({
            message:
                "Existing Rig data needs an upgrade before its stable data identity is available.",
            reason: "pre_identity",
            schemaVersion: RIG_DATA_IDENTITY_MIGRATION_INDEX,
            status: "upgrade_required",
        });
        expect(result.data).not.toHaveProperty("epoch");
        expect(rigInspectionExitCode(result)).toBe(0);
        expect(output).toEqual([
            "Installed Rig CLI version: 1.2.3",
            expect.stringMatching(/^Installed Rig CLI protocol version: \d+$/u),
            "Existing Rig data needs an upgrade before its stable data identity is available.",
            `Rig data schema version: ${String(RIG_DATA_IDENTITY_MIGRATION_INDEX)}`,
        ]);
    });

    it.each([
        {
            data: { status: "absent" },
            exitCode: 0,
            lines: ["Rig data has not been created."],
        },
        {
            data: { status: "uninitialized" },
            exitCode: 0,
            lines: ["Rig data exists but has not been initialized."],
        },
        {
            data: {
                message:
                    "Existing Rig data needs an upgrade before its stable data identity is available.",
                reason: "pre_identity",
                schemaVersion: 16,
                status: "upgrade_required",
            },
            exitCode: 0,
            lines: [
                "Existing Rig data needs an upgrade before its stable data identity is available.",
                "Rig data schema version: 16",
            ],
        },
        {
            data: {
                epoch: "epoch-current",
                schemaCompatibility: "current",
                schemaVersion: 19,
                status: "initialized",
            },
            exitCode: 0,
            lines: [
                "Rig data is initialized.",
                "Rig data epoch: epoch-current",
                "Rig data schema version: 19",
            ],
        },
        {
            data: {
                epoch: "epoch-upgrade",
                schemaCompatibility: "upgrade_required",
                schemaVersion: 18,
                status: "initialized",
            },
            exitCode: 0,
            lines: [
                "Rig data is initialized.",
                "Rig data epoch: epoch-upgrade",
                "Rig data schema version: 18",
                "Rig data requires an ordinary schema upgrade by this installed CLI.",
            ],
        },
        {
            data: {
                epoch: "epoch-future",
                message: "Install a newer Rig CLI.",
                reason: "newer_schema",
                schemaVersion: 20,
                status: "incompatible",
            },
            exitCode: 2,
            lines: ["Install a newer Rig CLI."],
        },
        {
            data: {
                message: "Rig data cannot be read.",
                reason: "unreadable",
                status: "unavailable",
            },
            exitCode: 2,
            lines: ["Rig data cannot be read."],
        },
    ] satisfies readonly {
        data: RigInstallationData;
        exitCode: 0 | 2;
        lines: readonly string[];
    }[])("renders and classifies the $data.status branch", ({ data, exitCode, lines }) => {
        const value = inspection(data);
        expect(formatRigInspection(value)).toEqual([
            "Installed Rig CLI version: 1.2.3",
            "Installed Rig CLI protocol version: 5",
            ...lines,
        ]);
        expect(rigInspectionExitCode(value)).toBe(exitCode);
    });
});

function inspection(data: RigInstallationData): RigCliInstallationInspection {
    return {
        cliProtocolVersion: 5,
        cliVersion: "1.2.3",
        data,
        formatVersion: 1,
        source: "cli",
    };
}

function testDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "rig-cli-inspection-"));
    directories.push(directory);
    return directory;
}
