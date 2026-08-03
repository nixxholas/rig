import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
    RigCliInstallationInspection,
    RigInstallationData,
} from "../protocol/InstallationProtocol.js";
import { migrateSessionDatabase } from "../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../persistence/database/openSessionDatabase.js";
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
    it("prints stable machine-readable clean-install facts without creating daemon state", () => {
        const root = testDirectory();
        const daemonDirectory = join(root, "daemon");
        const databasePath = join(daemonDirectory, "sessions.sqlite");
        const output: string[] = [];

        const inspection = runRigInspection({
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

    it("prints initialized data and its stable epoch in human-readable English", () => {
        const root = testDirectory();
        const databasePath = join(root, "sessions.sqlite");
        const database = openSessionDatabase(databasePath);
        migrateSessionDatabase(database.database, { createDataEpoch: () => "epoch-one" });
        database.client.close();
        const output: string[] = [];

        runRigInspection({
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
