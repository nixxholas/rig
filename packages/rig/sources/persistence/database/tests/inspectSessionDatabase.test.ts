import { describe, expect, it } from "vitest";

import { inspectSessionDatabase } from "../inspectSessionDatabase.js";
import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../migrateSessionDatabase.js";
import { openSessionDatabase } from "../openSessionDatabase.js";

describe("inspectSessionDatabase", () => {
    it("inspects a migrated database through the locked async connection", async () => {
        const opened = await openSessionDatabase(":memory:");
        try {
            await migrateSessionDatabase(opened.database);

            expect(await inspectSessionDatabase(opened.database)).toEqual({
                counts: {
                    activeProjects: 0,
                    activeRootSessions: 0,
                    activeWorkspaces: 0,
                    projects: 0,
                    rootSessions: 0,
                    sessionEvents: 0,
                    sessionMessages: 0,
                    sessions: 0,
                    workspaces: 0,
                },
                foreignKeyViolations: 0,
                integrity: "ok",
                invalidJsonRows: 0,
                schemaVersion: CURRENT_SESSION_DATABASE_VERSION,
            });
        } finally {
            await opened.database.close();
        }
    });
});
