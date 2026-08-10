import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { migrateSessionDatabase } from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import { onboardingMarkCompleted } from "../onboardingMarkCompleted.js";
import { queryOnboardingState } from "../queryOnboardingState.js";

const directories: string[] = [];
const root = createTestRootContext();

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("onboarding persistence", () => {
    it("starts with an uncompleted onboarding state", async () => {
        const opened = await openOnboardingDatabase();
        try {
            expect(await queryOnboardingState(opened.ctx)).toEqual({ completedVersion: 0 });
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("advances completion monotonically", async () => {
        const opened = await openOnboardingDatabase();
        try {
            expect(await onboardingMarkCompleted(opened.ctx, 2)).toBe(true);
            expect(await onboardingMarkCompleted(opened.ctx, 2)).toBe(false);
            expect(await onboardingMarkCompleted(opened.ctx, 1)).toBe(false);
            expect(await queryOnboardingState(opened.ctx)).toEqual({ completedVersion: 2 });
        } finally {
            await opened.database.close(opened.ctx);
        }
    });

    it("persists completion across a database restart", async () => {
        const directory = createDirectory();
        const databasePath = join(directory, "sessions.sqlite");
        const first = await openSessionDatabase(root, databasePath);
        await migrateSessionDatabase(first.ctx);
        await onboardingMarkCompleted(first.ctx, 4);
        await first.database.close(first.ctx);

        const restarted = await openSessionDatabase(root, databasePath);
        try {
            await migrateSessionDatabase(restarted.ctx);
            expect(await queryOnboardingState(restarted.ctx)).toEqual({ completedVersion: 4 });
        } finally {
            await restarted.database.close(restarted.ctx);
        }
    });

    it("rejects invalid durable values before writing", async () => {
        const opened = await openOnboardingDatabase();
        try {
            await expect(onboardingMarkCompleted(opened.ctx, -1)).rejects.toThrow(
                "The onboarding completion version is invalid.",
            );
            expect(await queryOnboardingState(opened.ctx)).toEqual({ completedVersion: 0 });
        } finally {
            await opened.database.close(opened.ctx);
        }
    });
});

async function openOnboardingDatabase() {
    const directory = createDirectory();
    const opened = await openSessionDatabase(root, join(directory, "sessions.sqlite"));
    await migrateSessionDatabase(opened.ctx);
    return opened;
}

function createDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "rig-onboarding-persistence-"));
    directories.push(directory);
    return directory;
}
