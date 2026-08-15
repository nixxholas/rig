import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { sql } from "drizzle-orm";

import type {
    AgentTreeRelation,
    AgentTreeUsage,
    AgentTreeUsageSession,
} from "../../agent/context/AgentTreeUsageContext.js";
import { MAX_AGENT_TREE_USAGE_SESSIONS } from "../../agent/context/AgentTreeUsageContext.js";
import { readNumber, readOptionalString, readString } from "./impl/sqliteRow.js";

/**
 * Reads one durable session subtree without loading transcripts or active session objects.
 *
 * The extra row makes the size bound explicit without ever returning a partial, misleading total.
 */
export async function queryAgentTreeUsage(
    ctx: Context,
    rootSessionId: string,
): Promise<AgentTreeUsage | undefined> {
    return await inDatabase(ctx, "rig.sql.session.query_agent_tree_usage", async (ctx) => {
        const tx = ctx.tx;
        const rows = await tx.all<Record<string, unknown>>(sql`
        WITH RECURSIVE descendants(id) AS (
            SELECT id
            FROM sessions
            WHERE id = ${rootSessionId}
            UNION
            SELECT child.id
            FROM sessions child INDEXED BY sessions_parent_created
            JOIN descendants parent
                ON child.parent_session_id = parent.id
            UNION
            SELECT child.id
            FROM sessions child INDEXED BY sessions_delegated_created
            JOIN descendants parent
                ON child.delegated_by_session_id = parent.id
            LIMIT ${MAX_AGENT_TREE_USAGE_SESSIONS + 1}
        )
        SELECT id, agent_id, provider_id, model_id, status, parent_session_id,
            delegated_by_session_id, lifetime_total_tokens, created_at_ms, title,
            description, task_name
        FROM sessions
        WHERE id IN descendants
        ORDER BY
            CASE WHEN id = ${rootSessionId} THEN 0 ELSE 1 END,
            created_at_ms ASC,
            id ASC
    `);
        if (rows.length === 0) return undefined;
        if (rows.length > MAX_AGENT_TREE_USAGE_SESSIONS) {
            throw new Error(
                `Agent tree usage is limited to ${MAX_AGENT_TREE_USAGE_SESSIONS.toLocaleString("en-US")} sessions.`,
            );
        }

        const returnedIds = new Set(rows.map((row) => readString(row, "id")));
        const sessions = rows.map((row) => readUsageSession(row, rootSessionId, returnedIds));
        return {
            sessions,
            totalTokens: sessions.reduce((total, session) => total + session.totalTokens, 0),
        };
    });
}

function readUsageSession(
    row: Record<string, unknown>,
    rootSessionId: string,
    returnedIds: ReadonlySet<string>,
): AgentTreeUsageSession {
    const sessionId = readString(row, "id");
    const parentSessionId = readOptionalString(row, "parent_session_id");
    const delegatedBySessionId = readOptionalString(row, "delegated_by_session_id");
    if (parentSessionId !== undefined && delegatedBySessionId !== undefined) {
        throw new Error(`Session '${sessionId}' has both subagent and delegation parents.`);
    }
    const relation: AgentTreeRelation =
        sessionId === rootSessionId
            ? "root"
            : parentSessionId !== undefined
              ? "subagent"
              : "delegated";
    const directParentSessionId =
        relation === "subagent"
            ? parentSessionId
            : relation === "delegated"
              ? delegatedBySessionId
              : undefined;
    if (directParentSessionId !== undefined && !returnedIds.has(directParentSessionId)) {
        throw new Error(`Session '${sessionId}' has a parent outside the returned agent tree.`);
    }
    const description = readOptionalString(row, "description");
    const taskName = readOptionalString(row, "task_name");
    const title = readOptionalString(row, "title");

    return {
        agentId: readString(row, "agent_id"),
        ...(description === undefined ? {} : { description }),
        modelId: readString(row, "model_id"),
        ...(directParentSessionId === undefined ? {} : { parentSessionId: directParentSessionId }),
        providerId: readString(row, "provider_id"),
        relation,
        sessionId,
        status: readString(row, "status"),
        ...(taskName === undefined ? {} : { taskName }),
        ...(title === undefined ? {} : { title }),
        totalTokens: readNumber(row, "lifetime_total_tokens"),
    };
}
