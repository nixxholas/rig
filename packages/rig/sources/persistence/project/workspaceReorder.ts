import { sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export function workspaceReorder(
    tx: TX,
    projectId: string,
    id: string,
    orderKey: string,
    now: number,
    version?: number,
): number {
    return Number(
        tx
            .update(projectWorkspaces)
            .set({
                orderKey,
                updatedAtMs: now,
                version: sql`${projectWorkspaces.version} + 1`,
            })
            .where(workspaceScope(projectId, id, version))
            .run().changes,
    );
}
