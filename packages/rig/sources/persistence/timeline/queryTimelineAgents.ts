import { sql } from "drizzle-orm";

import type { SessionAgentType, TimelineScope } from "../../protocol/index.js";
import type { TimelineAgentSource } from "../../timeline/index.js";
import type { TX } from "../Transaction.js";
import { readNumber, readOptionalString, readString } from "../session/impl/sqliteRow.js";
import { sessionScopeFromRow } from "../session/impl/sessionScope.js";

const COLUMNS = sql`
    id, agent_id, scope_kind, project_id, workspace_id, folder_id, session_kind, parent_session_id,
    parent_tool_call_id, depth, task_name, description, title, archived,
    provider_id, model_id, status, created_at_ms
`;

/**
 * Every agent a timeline covers, ordered by when it came into being.
 *
 * A global timeline covers every agent at once. A project reaches its
 * workspaces and every chat inside them, a workspace stops at that worktree,
 * and a session covers itself together with the subagents it started, however
 * deeply they nest.
 */
export function queryTimelineAgents(
    tx: TX,
    scope: TimelineScope,
    includeArchived: boolean,
): readonly TimelineAgentSource[] {
    return agentRows(tx, scope)
        .map(readTimelineAgentRow)
        .filter((agent) => includeArchived || !agent.archived);
}

function agentRows(tx: TX, scope: TimelineScope): Record<string, unknown>[] {
    if (scope.kind === "global") {
        // Deliberately unfiltered. A global timeline grows with everything Rig
        // has ever run, and callers bound it with `since` when that matters.
        return tx.all<Record<string, unknown>>(sql`
            SELECT ${COLUMNS} FROM sessions
            ORDER BY created_at_ms ASC
        `);
    }
    if (scope.kind === "session") {
        return tx.all<Record<string, unknown>>(sql`
            WITH RECURSIVE descendants(id) AS (
                SELECT id FROM sessions WHERE id = ${scope.sessionId}
                UNION
                SELECT sessions.id FROM sessions
                JOIN descendants ON sessions.parent_session_id = descendants.id
            )
            SELECT ${COLUMNS} FROM sessions
            WHERE id IN (SELECT id FROM descendants)
            ORDER BY created_at_ms ASC
        `);
    }
    if (scope.kind === "workspace") {
        return tx.all<Record<string, unknown>>(sql`
            SELECT ${COLUMNS} FROM sessions
            WHERE workspace_id = ${scope.workspaceId}
            ORDER BY created_at_ms ASC
        `);
    }
    return tx.all<Record<string, unknown>>(sql`
        SELECT ${COLUMNS} FROM sessions
        WHERE project_id = ${scope.projectId}
        ORDER BY created_at_ms ASC
    `);
}

function readTimelineAgentRow(row: Record<string, unknown>): TimelineAgentSource {
    const status = readString(row, "status");
    const parentSessionId = readOptionalString(row, "parent_session_id");
    const parentToolCallId = readOptionalString(row, "parent_tool_call_id");
    const taskName = readOptionalString(row, "task_name");
    const description = readOptionalString(row, "description");
    const title = readOptionalString(row, "title");
    return {
        agentId: readString(row, "agent_id"),
        archived: readNumber(row, "archived") !== 0,
        createdAt: readNumber(row, "created_at_ms"),
        depth: readNumber(row, "depth"),
        modelId: readString(row, "model_id"),
        scope: sessionScopeFromRow(row),
        providerId: readString(row, "provider_id"),
        sessionId: readString(row, "id"),
        type: readString(row, "session_kind") as SessionAgentType,
        working: status === "running" || status === "queued",
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
        ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
        ...(description === undefined ? {} : { description }),
        ...(taskName === undefined ? {} : { taskName }),
        ...(title === undefined ? {} : { title }),
    };
}
