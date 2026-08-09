import { inDatabase } from "../database/inDatabase.js";
import { and, eq, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceMarkReady(
    tx: DatabaseScope,
    projectId: string,
    id: string,
    now: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        error: null,
                        presence: "present",
                        status: "ready",
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(
                        and(
                            workspaceScope(projectId, id),
                            eq(projectWorkspaces.status, "initializing"),
                        ),
                    )
                    .run()
            ).rowsAffected,
        );
    });
}
