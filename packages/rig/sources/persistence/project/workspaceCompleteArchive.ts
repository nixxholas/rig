import { and, eq, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceCompleteArchive(
    tx: TX,
    projectId: string,
    id: string,
    now: number,
): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                archivedAtMs: now,
                error: null,
                status: "archived",
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(and(workspaceScope(projectId, id), eq(projectWorkspaces.status, "archiving")))
            .run().changes,
    );
}
