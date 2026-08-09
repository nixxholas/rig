import { inDatabase } from "../database/inDatabase.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { projects } from "../database/schema.js";
import type { DatabaseScope } from "../Transaction.js";
import { projectGitChanged, type GitValues } from "./projectConditions.js";

export async function projectApplyProbe(
    tx: DatabaseScope,
    id: string,
    values: GitValues & {
        presence: string;
        worktreeSupport: string;
        worktreeSupportReason: string | null;
    },
    now: number,
): Promise<number> {
    return await inDatabase(tx, async (tx) => {
        return Number(
            (
                await tx
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
                    .run()
            ).rowsAffected,
        );
    });
}
