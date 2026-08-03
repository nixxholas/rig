import { basename } from "node:path";

import { and, asc, eq } from "drizzle-orm";

import type {
    ScopeShareScopeFacts,
    ScopeShareSessionIndex,
} from "../../scope-sharing/projectScopeShareEntry.js";
import { projects, projectWorkspaces, sessions } from "../database/schema.js";
import type { TX } from "../Transaction.js";
import type { ScopeShareScopeKind } from "./types.js";

/**
 * How a session's provider and model are named to a member.
 *
 * A member has no provider registry of the owner's and cannot resolve an id, so the
 * label travels already resolved. The identifiers are the fallback, never a path or
 * a credential.
 */
export interface ScopeShareSessionLabels {
    readonly modelLabel: string;
    readonly providerLabel: string;
}

export type ScopeShareLabelResolver = (session: {
    modelId: string;
    providerId: string;
}) => ScopeShareSessionLabels;

const identityLabels: ScopeShareLabelResolver = (session) => ({
    modelLabel: session.modelId,
    providerLabel: session.providerId,
});

/**
 * The facts a shared project or workspace publishes about itself, with the row
 * version they were read at so an unchanged scope is never republished.
 *
 * Only the folder's own name travels. The path that leads to it, the working tree,
 * and everything configured on the scope stay on the owner's machine.
 */
export function queryScopeShareScopeFacts(
    tx: TX,
    scope: { scopeId: string; scopeKind: ScopeShareScopeKind },
): { facts: ScopeShareScopeFacts; version: number } | undefined {
    if (scope.scopeKind === "project") {
        const row = tx.select().from(projects).where(eq(projects.id, scope.scopeId)).get();
        if (row === undefined) return undefined;
        return {
            facts: {
                archived: row.archivedAtMs !== null,
                createdAt: row.createdAtMs,
                folderName: basename(row.path),
                gitAhead: row.gitAhead,
                gitBehind: row.gitBehind,
                ...(row.gitBranch === null ? {} : { gitBranch: row.gitBranch }),
                gitDetached: row.gitDetached,
                ...(row.gitHead === null ? {} : { gitHead: row.gitHead }),
                name: row.name,
                scopeId: row.id,
                scopeKind: "project",
                status: row.initializationStatus,
                updatedAt: row.updatedAtMs,
            },
            version: row.version,
        };
    }
    const row = tx
        .select()
        .from(projectWorkspaces)
        .where(eq(projectWorkspaces.id, scope.scopeId))
        .get();
    if (row === undefined) return undefined;
    return {
        facts: {
            archived: row.archivedAtMs !== null,
            ...(row.baseCommit === null ? {} : { baseCommit: row.baseCommit }),
            ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
            createdAt: row.createdAtMs,
            folderName: basename(row.path),
            gitAhead: row.gitAhead,
            gitBehind: row.gitBehind,
            ...(row.gitBranch === null ? {} : { gitBranch: row.gitBranch }),
            gitDetached: row.gitDetached,
            ...(row.gitHead === null ? {} : { gitHead: row.gitHead }),
            name: row.name,
            scopeId: row.id,
            scopeKind: "workspace",
            status: row.status,
            ...(row.title === null ? {} : { title: row.title }),
            updatedAt: row.updatedAtMs,
        },
        version: row.version,
    };
}

/**
 * Every session a scope share replicates.
 *
 * A project share covers the whole project, including the sessions that belong to
 * no workspace at all; a workspace share covers exactly that workspace.
 */
export function queryScopeShareSessionIds(
    tx: TX,
    scope: { scopeId: string; scopeKind: ScopeShareScopeKind },
): readonly string[] {
    return tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
            scope.scopeKind === "project"
                ? eq(sessions.projectId, scope.scopeId)
                : eq(sessions.workspaceId, scope.scopeId),
        )
        .orderBy(asc(sessions.createdAtMs), asc(sessions.id))
        .all()
        .map((row) => row.id);
}

/**
 * One session's place in the shared scope: who it is and how it is going, with
 * none of what it said and nothing it was configured with.
 */
export function queryScopeShareSessionIndex(
    tx: TX,
    input: {
        resolveLabels?: ScopeShareLabelResolver;
        scope: { scopeId: string; scopeKind: ScopeShareScopeKind };
        sessionId: string;
    },
): { index: ScopeShareSessionIndex; version: number } | undefined {
    const row = tx
        .select()
        .from(sessions)
        .where(
            and(
                eq(sessions.id, input.sessionId),
                input.scope.scopeKind === "project"
                    ? eq(sessions.projectId, input.scope.scopeId)
                    : eq(sessions.workspaceId, input.scope.scopeId),
            ),
        )
        .get();
    if (row === undefined) return undefined;
    const labels = (input.resolveLabels ?? identityLabels)({
        modelId: row.modelId,
        providerId: row.providerId,
    });
    return {
        index: {
            agentKind: row.sessionKind,
            archived: row.archived,
            createdAt: row.createdAtMs,
            ...(row.description === null ? {} : { description: row.description }),
            modelLabel: labels.modelLabel,
            ...(row.parentSessionId === null ? {} : { parentSessionId: row.parentSessionId }),
            providerLabel: labels.providerLabel,
            rootSessionId: row.rootSessionId,
            sessionId: row.id,
            status: row.status,
            ...(row.title === null ? {} : { title: row.title }),
            updatedAt: row.updatedAtMs,
            ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
        },
        version: row.updatedAtMs,
    };
}
