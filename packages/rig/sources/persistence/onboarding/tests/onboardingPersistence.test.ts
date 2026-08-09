import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { onboardingMarkCompleted } from "../onboardingMarkCompleted.js";
import { queryOnboardingState } from "../queryOnboardingState.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("onboarding persistence", () => {
    it("starts with an uncompleted onboarding state", () => {
        const opened = openOnboardingDatabase();
        try {
            expect(queryOnboardingState(opened.database)).toEqual({ completedVersion: 0 });
        } finally {
            opened.client.close();
        }
    });

    it("advances completion monotonically", () => {
        const opened = openOnboardingDatabase();
        try {
            expect(onboardingMarkCompleted(opened.database, 2)).toBe(true);
            expect(onboardingMarkCompleted(opened.database, 2)).toBe(false);
            expect(onboardingMarkCompleted(opened.database, 1)).toBe(false);
            expect(queryOnboardingState(opened.database)).toEqual({ completedVersion: 2 });
        } finally {
            opened.client.close();
        }
    });

    it("persists completion across a database restart", () => {
        const directory = createDirectory();
        const databasePath = join(directory, "sessions.sqlite");
        const first = openSessionDatabase(databasePath);
        migrateSessionDatabase(first.database);
        onboardingMarkCompleted(first.database, 4);
        first.client.close();

        const restarted = openSessionDatabase(databasePath);
        try {
            migrateSessionDatabase(restarted.database);
            expect(queryOnboardingState(restarted.database)).toEqual({ completedVersion: 4 });
        } finally {
            restarted.client.close();
        }
    });

    it("rejects invalid durable values before writing", () => {
        const opened = openOnboardingDatabase();
        try {
            expect(() => onboardingMarkCompleted(opened.database, -1)).toThrow(
                "The onboarding completion version is invalid.",
            );
            expect(queryOnboardingState(opened.database)).toEqual({ completedVersion: 0 });
        } finally {
            opened.client.close();
        }
    });
});

function openOnboardingDatabase() {
    const directory = createDirectory();
    const opened = openSessionDatabase(join(directory, "sessions.sqlite"));
    migrateSessionDatabase(opened.database);
    return opened;
}

function createDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "rig-onboarding-persistence-"));
    directories.push(directory);
    return directory;
}
