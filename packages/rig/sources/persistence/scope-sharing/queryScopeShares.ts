import { and, asc, eq, ne } from "drizzle-orm";

import { scopeShares } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import { shareRecord } from "./queryScopeShare.js";
import type { ScopeShareRecord } from "./types.js";

export function queryRecoverableScopeShares(tx: TX): readonly ScopeShareRecord[] {
    return tx
        .select()
        .from(scopeShares)
        .where(ne(scopeShares.state, "stopped"))
        .orderBy(asc(scopeShares.createdAtMs), asc(scopeShares.shareId))
        .all()
        .map(shareRecord);
}

export function queryStoppedScopeShares(tx: TX): readonly ScopeShareRecord[] {
    return tx
        .select()
        .from(scopeShares)
        .where(eq(scopeShares.state, "stopped"))
        .orderBy(asc(scopeShares.stoppedAtMs), asc(scopeShares.shareId))
        .all()
        .map(shareRecord);
}

/**
 * Every live share beneath one project, in the order they must be stopped.
 *
 * Archiving a project stops its own share and every workspace share under it, so
 * the workspaces come first and the project's own share last.
 */
export function queryLiveScopeSharesInProject(
    tx: TX,
    projectId: string,
): readonly ScopeShareRecord[] {
    return tx
        .select()
        .from(scopeShares)
        .where(and(eq(scopeShares.projectId, projectId), ne(scopeShares.state, "stopped")))
        .orderBy(asc(scopeShares.scopeKind), asc(scopeShares.createdAtMs), asc(scopeShares.shareId))
        .all()
        .map(shareRecord)
        .sort(
            (left, right) =>
                Number(left.scopeKind === "project") - Number(right.scopeKind === "project"),
        );
}
