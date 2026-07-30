import { count, eq, sql } from "drizzle-orm";

import { projectAvatarAssets, projects } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";

export function projectClearAvatar(tx: TX, projectId: string, now: number): number {
    return inTx(tx, (tx) => {
        const current = tx
            .select({ avatarHash: projects.avatarHash })
            .from(projects)
            .where(eq(projects.id, projectId))
            .get();
        if (current === undefined) return 0;
        const result = tx
            .update(projects)
            .set({
                avatarHash: null,
                avatarSource: null,
                initializationError: sql`CASE WHEN ${projects.kind} = 'regular' THEN NULL ELSE ${projects.initializationError} END`,
                initializationStatus: sql`CASE WHEN ${projects.kind} = 'regular' THEN 'initializing' ELSE ${projects.initializationStatus} END`,
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(eq(projects.id, projectId))
            .run();
        if (current.avatarHash !== null) {
            const references = tx
                .select({ value: count() })
                .from(projects)
                .where(eq(projects.avatarHash, current.avatarHash))
                .get();
            if (references?.value === 0) {
                tx.update(projectAvatarAssets)
                    .set({ dereferencedAtMs: now })
                    .where(eq(projectAvatarAssets.hash, current.avatarHash))
                    .run();
            }
        }
        return Number(result.changes);
    });
}
