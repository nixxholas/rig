import { sql } from "drizzle-orm";

import type { AgentWorkspaceSession } from "../../agent/context/WorkspaceContext.js";
import type { TX } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "./impl/sqliteRow.js";

/**
 * Lists the visible conversations of a project or workspace for an agent that is looking around.
 *
 * Subagents are left out: they belong to the session that started them rather than to the
 * workspace, and they are reached through the subagent tools instead.
 */
export function queryWorkspaceSessions(
    tx: TX,
    target: { limit?: number; projectId: string; workspaceId?: string },
): readonly AgentWorkspaceSession[] {
    const rows = tx.all<Record<string, unknown>>(sql`
        SELECT id, agent_id, project_id, workspace_id, title, status, archived, updated_at_ms,
            last_message_at_ms, delegated_by_session_id
        FROM sessions
        WHERE project_id = ${target.projectId}
            AND parent_session_id IS NULL
            ${
                target.workspaceId === undefined
                    ? sql`AND scope_kind = 'project'`
                    : sql`AND scope_kind = 'workspace'
                          AND workspace_id = ${target.workspaceId}`
            }
        ORDER BY last_message_at_ms DESC, updated_at_ms DESC, id ASC
        LIMIT ${target.limit ?? 100}
    `);

    return rows.map((row) => {
        const workspaceId = readOptionalString(row, "workspace_id");
        const title = readOptionalString(row, "title");
        const delegatedBy = readOptionalString(row, "delegated_by_session_id");
        return {
            archived: readNumber(row, "archived") !== 0,
            id: readString(row, "id"),
            agentId: readString(row, "agent_id"),
            projectId: readString(row, "project_id"),
            ...(workspaceId === undefined ? {} : { workspaceId }),
            title: title ?? "Untitled conversation",
            status: readString(row, "status"),
            updatedAt: readNumber(row, "updated_at_ms"),
            ...(delegatedBy === undefined ? {} : { delegatedBy }),
        };
    });
}
