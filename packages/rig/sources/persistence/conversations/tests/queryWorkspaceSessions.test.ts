import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createSessionDatabaseFixture } from "../../database/tests/createSessionDatabaseFixture.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";
import { sessions } from "../../database/schema.js";
import { queryWorkspaceSessions } from "../queryWorkspaceSessions.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";

describe("queryWorkspaceSessions", () => {
    it("identifies an archived conversation whose activity status is still idle", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-workspace-sessions-"));
        const databasePath = join(directory, "sessions.sqlite");
        await createSessionDatabaseFixture(databasePath);
        const opened = await openSessionDatabase(createTestRootContext(), databasePath);
        try {
            await opened.ctx.tx
                .update(sessions)
                .set({ archived: true })
                .where(eq(sessions.id, "session-1"))
                .run();

            expect(await queryWorkspaceSessions(opened.ctx, { projectId: "project-1" })).toEqual([
                expect.objectContaining({
                    archived: true,
                    id: "session-1",
                    status: "idle",
                }),
            ]);
        } finally {
            await opened.database.close(opened.ctx);
            await rm(directory, { force: true, recursive: true });
        }
    });
});
