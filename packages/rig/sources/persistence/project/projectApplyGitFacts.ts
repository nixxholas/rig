import { and, eq, isNull, sql } from "drizzle-orm";
import type { GitRepositoryFacts } from "../../protocol/index.js";
import { projects } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { projectGitChanged, type GitValues } from "./projectConditions.js";

export function projectApplyGitFacts(
    tx: TX,
    id: string,
    facts: GitRepositoryFacts,
    now: number,
): number {
    const values: GitValues = {
        gitAhead: facts.ahead,
        gitBehind: facts.behind,
        gitBranch: facts.branch ?? null,
        gitDetached: facts.detached,
        gitHead: facts.head ?? null,
        gitUpstream: facts.upstream ?? null,
    };
    return Number(
        tx
            .update(projects)
            .set({
                ...values,
                updatedAtMs: now,
                version: sql`${projects.version} + 1`,
            })
            .where(
                and(eq(projects.id, id), isNull(projects.archivedAtMs), projectGitChanged(values)),
            )
            .run().changes,
    );
}
