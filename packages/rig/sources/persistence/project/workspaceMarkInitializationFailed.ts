import { and, eq, sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceMarkInitializationFailed(
    tx: TX,
    projectId: string,
    id: string,
    error: string,
    now: number,
): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                error,
                status: "failed",
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(and(workspaceScope(projectId, id), eq(projectWorkspaces.status, "initializing")))
            .run().changes,
    );
}
