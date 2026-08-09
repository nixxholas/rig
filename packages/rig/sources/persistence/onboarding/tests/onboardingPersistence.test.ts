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
    it("starts with an uncompleted onboarding state", async () => {
        const opened = await openOnboardingDatabase();
        try {
            expect(await queryOnboardingState(opened.database)).toEqual({ completedVersion: 0 });
        } finally {
            opened.client.close();
        }
    });

    it("advances completion monotonically", async () => {
        const opened = await openOnboardingDatabase();
        try {
            expect(await onboardingMarkCompleted(opened.database, 2)).toBe(true);
            expect(await onboardingMarkCompleted(opened.database, 2)).toBe(false);
            expect(await onboardingMarkCompleted(opened.database, 1)).toBe(false);
            expect(await queryOnboardingState(opened.database)).toEqual({ completedVersion: 2 });
        } finally {
            opened.client.close();
        }
    });

    it("persists completion across a database restart", async () => {
        const directory = createDirectory();
        const databasePath = join(directory, "sessions.sqlite");
        const first = await openSessionDatabase(databasePath);
        await migrateSessionDatabase(first.database);
        await onboardingMarkCompleted(first.database, 4);
        first.client.close();

        const restarted = await openSessionDatabase(databasePath);
        try {
            await migrateSessionDatabase(restarted.database);
            expect(await queryOnboardingState(restarted.database)).toEqual({ completedVersion: 4 });
        } finally {
            restarted.client.close();
        }
    });

    it("rejects invalid durable values before writing", async () => {
        const opened = await openOnboardingDatabase();
        try {
            await expect(onboardingMarkCompleted(opened.database, -1)).rejects.toThrow(
                "The onboarding completion version is invalid.",
            );
            expect(await queryOnboardingState(opened.database)).toEqual({ completedVersion: 0 });
        } finally {
            opened.client.close();
        }
    });
});

async function openOnboardingDatabase() {
    const directory = createDirectory();
    const opened = await openSessionDatabase(join(directory, "sessions.sqlite"));
    await migrateSessionDatabase(opened.database);
    return opened;
}

function createDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "rig-onboarding-persistence-"));
    directories.push(directory);
    return directory;
}
