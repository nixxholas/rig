import { count, eq, sql } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { DatabaseScope } from "../Transaction.js";

export async function projectClearAvatar(
    tx: DatabaseScope,
    projectId: string,
    now: number,
): Promise<number> {
    return await inTx(tx, async (tx) => {
        const current = await tx
            .select({ avatarHash: projects.avatarHash })
            .from(projects)
            .where(eq(projects.id, projectId))
            .get();
        if (current === undefined) return 0;
        const result = await tx
            .update(projects)
            .set({
                avatarHash: null,
                avatarSource: null,
                initializationError: sql`CASE WHEN ${projects.kind} = 'regular' THEN NULL ELSE ${projects.initializationError} END`,
                initializationStatus: sql`CASE WHEN ${projects.kind} = 'regular' THEN 'initializing' ELSE ${projects.initializationStatus} END`,
                updatedAtMs: now,
                userMutationVersion: sql`${projects.version} + 1`,
                version: sql`${projects.version} + 1`,
            })
            .where(eq(projects.id, projectId))
            .run();
        if (current.avatarHash !== null) {
            const references = await tx
                .select({ value: count() })
                .from(projects)
                .where(eq(projects.avatarHash, current.avatarHash))
                .get();
            if (references?.value === 0) {
                await tx
                    .update(projectAvatarAssets)
                    .set({ dereferencedAtMs: now })
                    .where(eq(projectAvatarAssets.hash, current.avatarHash))
                    .run();
            }
        }
        return Number(result.rowsAffected);
    });
}
