import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";
import { projectWorkspaces } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { workspaceScope } from "./workspaceScope.js";

export async function workspaceReorder(
    tx: DatabaseScope,
    projectId: string,
    id: string,
    orderKey: string,
    now: number,
    version?: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
                    .update(projectWorkspaces)
                    .set({
                        orderKey,
                        updatedAtMs: now,
                        version: sql`${projectWorkspaces.version} + 1`,
                    })
                    .where(workspaceScope(projectId, id, version))
                    .run()
            ).rowsAffected,
        );
    });
}
