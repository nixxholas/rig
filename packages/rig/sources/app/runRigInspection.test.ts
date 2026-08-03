import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../persistence/database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../persistence/database/openSessionDatabase.js";
import { runRigInspection } from "./runRigInspection.js";

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
            data: { status: "absent" },
            formatVersion: 1,
            protocolVersion: expect.any(Number),
            rigVersion: "1.2.3",
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
            "Rig version: 1.2.3",
            expect.stringMatching(/^Rig protocol version: \d+$/u),
            "Rig data is initialized.",
            "Rig data epoch: epoch-one",
        ]);
    });
});

function testDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "rig-cli-inspection-"));
    directories.push(directory);
    return directory;
}
