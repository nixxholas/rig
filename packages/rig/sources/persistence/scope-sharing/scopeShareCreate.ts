import { and, eq, ne } from "drizzle-orm";

import {
    projectWorkspaces,
    scopeShareGrants,
    scopeShareMembers,
    scopeShares,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { queryScopeShare } from "./queryScopeShare.js";
import type { ScopeShareRecord, ScopeShareScopeKind } from "./types.js";

export function scopeShareCreate(
    tx: TX,
    input: {
        members: readonly { displayName: string; murmurPeerId: string; shareMemberId: string }[];
        now: number;
        ownerPeerId: string;
        scopeId: string;
        scopeKind: ScopeShareScopeKind;
        shareId: string;
    },
): ScopeShareRecord {
    return inTx(tx, (tx) => {
        if (input.members.length === 0) {
            throw new Error("A shared workspace or project needs at least one friend.");
        }
        const projectId = resolveProjectId(tx, input.scopeKind, input.scopeId);
        // A workspace inside a shared project is already replicated by that share, so
        // sharing it again would build a second MLS group over the same sessions and
        // let the two diverge with nothing to reconcile them.
        if (input.scopeKind === "workspace") {
            const projectShare = tx
                .select({ shareId: scopeShares.shareId })
                .from(scopeShares)
                .where(
                    and(
                        eq(scopeShares.scopeKind, "project"),
                        eq(scopeShares.scopeId, projectId),
                        ne(scopeShares.state, "stopped"),
                    ),
                )
                .get();
            if (projectShare !== undefined) {
                throw new Error(
                    "This workspace's project is already shared, so the workspace is shared with it.",
                );
            }
        }
        tx.insert(scopeShares)
            .values({
                createdAtMs: input.now,
                nextShareSequence: 1,
                outboxBytes: 0,
                outboxCount: 0,
                ownerPeerId: input.ownerPeerId,
                projectId,
                publishedScopeVersion: -1,
                scopeId: input.scopeId,
                scopeKind: input.scopeKind,
                shareId: input.shareId,
                state: "active",
                updatedAtMs: input.now,
            })
            .run();
        for (const member of input.members) {
            tx.insert(scopeShareMembers)
                .values({
                    createdAtMs: input.now,
                    currentGrantEpoch: 1,
                    displayName: member.displayName,
                    murmurPeerId: member.murmurPeerId,
                    shareId: input.shareId,
                    shareMemberId: member.shareMemberId,
                    state: "active",
                    updatedAtMs: input.now,
                })
                .run();
            tx.insert(scopeShareGrants)
                .values({
                    createdAtMs: input.now,
                    grantEpoch: 1,
                    shareMemberId: member.shareMemberId,
                    state: "active",
                })
                .run();
        }
        const share = queryScopeShare(tx, input.shareId);
        if (share === undefined) throw new Error("The scope share was not created.");
        return share;
    });
}

/**
 * The project the share hangs off, which is both its cascade and how archiving a
 * project finds every workspace share beneath it.
 */
function resolveProjectId(tx: TX, scopeKind: ScopeShareScopeKind, scopeId: string): string {
    if (scopeKind === "project") return scopeId;
    const workspace = tx
        .select({ projectId: projectWorkspaces.projectId })
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, scopeId))
        .get();
    if (workspace === undefined) throw new Error("The workspace to share does not exist.");
    return workspace.projectId;
}
