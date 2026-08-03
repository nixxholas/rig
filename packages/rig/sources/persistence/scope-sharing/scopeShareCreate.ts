import { and, eq, ne } from "drizzle-orm";

import {
    projectWorkspaces,
    scopeShareGrants,
    scopeShareMembers,
    scopeShares,
} from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { ScopeShareRequestError } from "../../scope-sharing/ScopeShareRequestError.js";
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
            throw new ScopeShareRequestError(
                "invalid_request",
                "A shared workspace or project needs at least one friend.",
            );
        }
        const projectId = resolveProjectId(tx, input.scopeKind, input.scopeId);
        // A project share and a workspace share beneath it replicate the same sessions.
        // Allowing both would build two MLS groups over one set of subjects and let them
        // diverge with nothing to reconcile them, so whichever came first wins and the
        // rule is enforced from both directions: it is one overlap, not two rules.
        const overlapping = tx
            .select({ scopeKind: scopeShares.scopeKind })
            .from(scopeShares)
            .where(
                and(
                    eq(scopeShares.projectId, projectId),
                    ne(scopeShares.scopeKind, input.scopeKind),
                    ne(scopeShares.state, "stopped"),
                ),
            )
            .get();
        if (overlapping !== undefined) {
            throw new ScopeShareRequestError(
                "already_shared",
                input.scopeKind === "workspace"
                    ? "This workspace's project is already shared, so the workspace is shared with it."
                    : "A workspace in this project is already shared on its own, so stop that share first.",
            );
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
