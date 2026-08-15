import type { Context } from "@steve.kite/stdlib";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { SessionScope } from "../../protocol/index.js";
import { generateKeyBetween } from "../../utils/fractionalIndexing.js";
import { orderKeyAfter } from "../../utils/orderKeyAfter.js";
import { folders, projectWorkspaces, sessions } from "../database/schema.js";
import { inTx } from "../inTx.js";
import type { TX } from "../Transaction.js";
import { querySessionOrderItems } from "./querySessionOrderItems.js";
import { sessionScopeValues } from "./impl/sessionScope.js";
import { sessionScopeFromRow } from "./impl/sessionScope.js";
import { readNumber, readString } from "./impl/sqliteRow.js";
import { querySessionMutationReceipt } from "./querySessionMutationReceipt.js";
import { sessionRecordMutationReceipt } from "./sessionRecordMutationReceipt.js";

export const SESSION_SCOPE_MUTATION_ACTION = "move_scope";

export interface SessionScopeMove {
    cwd: string;
    orderKey: string;
    scope: SessionScope;
    unsortedSince?: number;
}

/** Moves one root chat and its position into a different collection as one durable transition. */
export async function sessionMoveScope(
    ctx: Context,
    input: {
        afterId?: string | null;
        cwd: string;
        now: number;
        scope: SessionScope;
        sessionId: string;
        mutationId?: string;
    },
): Promise<SessionScopeMove> {
    return await inTx(ctx, "rig.sql.session.session_move_scope", async (ctx) => {
        const tx = ctx.tx;
        if (input.mutationId !== undefined) {
            const receipt = await querySessionMutationReceipt(ctx, {
                action: SESSION_SCOPE_MUTATION_ACTION,
                mutationId: input.mutationId,
                sessionId: input.sessionId,
            });
            if (receipt === "conflict") {
                throw new Error("That mutation ID was already used for another session change.");
            }
            if (receipt === "applied") return await queryCurrentScopeMove(tx, input.sessionId);
        }
        if (input.scope.kind === "folder") {
            const folder = await tx
                .select({ archivedAtMs: folders.archivedAtMs })
                .from(folders)
                .where(eq(folders.id, input.scope.folderId))
                .get();
            if (folder === undefined || folder.archivedAtMs !== null) {
                throw new Error("The session can only move into an active folder.");
            }
        }
        if (input.scope.kind === "workspace") {
            const workspace = await tx
                .select({ id: projectWorkspaces.id })
                .from(projectWorkspaces)
                .where(
                    and(
                        eq(projectWorkspaces.id, input.scope.workspaceId),
                        eq(projectWorkspaces.projectId, input.scope.projectId),
                    ),
                )
                .get();
            if (workspace === undefined) {
                throw new Error("That workspace does not belong to the requested project.");
            }
        }
        const current = await tx.get<{ scope_kind: string; unsorted_since_ms: number | null }>(sql`
            SELECT scope_kind, unsorted_since_ms
            FROM sessions
            WHERE id = ${input.sessionId}
                AND session_kind = 'primary'
                AND parent_session_id IS NULL
        `);
        if (current === undefined) throw new Error("The session is no longer available.");
        const targetItems = await querySessionOrderItems(ctx, input.scope);
        const existing = targetItems.find((item) => item.id === input.sessionId);
        const orderKey =
            input.afterId === undefined
                ? generateKeyBetween(
                      targetItems.filter((item) => item.id !== input.sessionId).at(-1)?.orderKey ??
                          null,
                      null,
                  )
                : orderKeyAfter(
                      existing === undefined
                          ? [
                                ...targetItems,
                                {
                                    id: input.sessionId,
                                    orderKey: generateKeyBetween(
                                        targetItems.at(-1)?.orderKey ?? null,
                                        null,
                                    ),
                                },
                            ]
                          : targetItems,
                      input.sessionId,
                      input.afterId,
                  );
        const unsortedSince =
            input.scope.kind === "unsorted"
                ? current.scope_kind === "unsorted"
                    ? (current.unsorted_since_ms ?? input.now)
                    : input.now
                : null;
        const changed = (
            await tx
                .update(sessions)
                .set({
                    ...sessionScopeValues(input.scope),
                    cwd: input.cwd,
                    orderKey,
                    unsortedSinceMs: unsortedSince,
                    updatedAtMs: input.now,
                })
                .where(
                    and(
                        eq(sessions.id, input.sessionId),
                        eq(sessions.sessionKind, "primary"),
                        isNull(sessions.parentSessionId),
                    ),
                )
                .run()
        ).rowsAffected;
        if (changed === 0) throw new Error("The session is no longer available.");
        if (input.mutationId !== undefined) {
            await sessionRecordMutationReceipt(ctx, {
                action: SESSION_SCOPE_MUTATION_ACTION,
                mutationId: input.mutationId,
                now: input.now,
                sessionId: input.sessionId,
            });
        }
        return {
            cwd: input.cwd,
            orderKey,
            scope: input.scope,
            ...(unsortedSince === null ? {} : { unsortedSince }),
        };
    });
}

async function queryCurrentScopeMove(tx: TX, sessionId: string): Promise<SessionScopeMove> {
    const row = await tx.get<Record<string, unknown>>(sql`
        SELECT cwd, folder_id, order_key, project_id, scope_kind, unsorted_since_ms, workspace_id
        FROM sessions
        WHERE id = ${sessionId}
            AND session_kind = 'primary'
            AND parent_session_id IS NULL
    `);
    if (row === undefined) throw new Error("The session is no longer available.");
    const unsortedSince = row.unsorted_since_ms;
    return {
        cwd: readString(row, "cwd"),
        orderKey: readString(row, "order_key"),
        scope: sessionScopeFromRow(row),
        ...(unsortedSince === null || unsortedSince === undefined
            ? {}
            : { unsortedSince: readNumber(row, "unsorted_since_ms") }),
    };
}
