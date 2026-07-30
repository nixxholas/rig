import { and, eq, isNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectGitChanged, type GitValues } from "./projectConditions.js";

export function projectApplyProbe(
    tx: TX,
    id: string,
    values: GitValues & {
        presence: string;
        worktreeSupport: string;
        worktreeSupportReason: string | null;
    },
    now: number,
): number {
    return Number(
        tx
            .update(projects)
            .set({
                ...values,
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(
                and(
                    eq(projects.id, id),
                    isNull(projects.archivedAtMs),
                    sql`(
        ${projects.presence} IS NOT ${values.presence}
        OR ${projects.worktreeSupport} IS NOT ${values.worktreeSupport}
        OR ${projects.worktreeSupportReason} IS NOT ${values.worktreeSupportReason}
        OR ${projectGitChanged(values)}
    )`,
                ),
            )
            .run().changes,
    );
}
