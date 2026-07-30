import { sql } from "drizzle-orm";

import type {
    SessionInterruption,
    SessionSummary,
    SessionTitleStatus,
    SessionTokenCount,
    SessionUnreadReason,
} from "../../protocol/index.js";
import { parsePermissionMode } from "../../permissions/index.js";
import type { DockerExecutionConfig } from "../../execution/index.js";
import { summarizeDockerExecution } from "../../execution/index.js";
import type { TX } from "../Transaction.js";
import {
    readNumber,
    readOptionalNumber,
    readOptionalString,
    readString,
} from "./impl/sqliteRow.js";

export function querySessionSummaries(
    tx: TX,
    activeOnly: boolean,
    options: { limit?: number },
): readonly SessionSummary[] {
    const rows = tx.all<Record<string, unknown>>(sql`
        SELECT listed_sessions.*
        FROM (
            SELECT
                id, project_id, workspace_id, order_key, archived, track_unread,
                unread_reason, unread_since_ms, cwd, draft, draft_updated_at_ms,
                docker_json, secret_ids_json, provider_id, model_id, permission_mode,
                effort, service_tier, status, title, title_status, title_error, recap,
                session_token_count_json, metadata_updated_at_ms, metadata_run_id,
                interruption_json, created_at_ms, updated_at_ms, last_message_at_ms,
                last_event_id
            FROM sessions
            WHERE parent_session_id IS NULL
                ${activeOnly ? sql`AND archived = 0` : sql``}
        ) AS listed_sessions
        JOIN projects ON projects.id = listed_sessions.project_id
        LEFT JOIN project_workspaces ON project_workspaces.id = listed_sessions.workspace_id
        ORDER BY
            projects.order_key ASC,
            listed_sessions.workspace_id IS NOT NULL ASC,
            project_workspaces.order_key ASC,
            listed_sessions.order_key ASC,
            listed_sessions.id ASC
        LIMIT ${options.limit ?? (activeOnly ? -1 : 500)}
    `);

    return rows.map((row) => {
        const effort = readOptionalString(row, "effort");
        const serviceTier = readOptionalString(row, "service_tier");
        const title = readOptionalString(row, "title");
        const titleError = readOptionalString(row, "title_error");
        const recap = readOptionalString(row, "recap");
        const sessionTokenCountJson = readOptionalString(row, "session_token_count_json");
        const metadataUpdatedAt = readOptionalNumber(row, "metadata_updated_at_ms");
        const metadataRunId = readOptionalString(row, "metadata_run_id");
        const lastMessageAt = readOptionalNumber(row, "last_message_at_ms");
        const lastEventId = readOptionalString(row, "last_event_id");
        const interruptionJson = readOptionalString(row, "interruption_json");
        const draft = readOptionalString(row, "draft");
        const draftUpdatedAt = readOptionalNumber(row, "draft_updated_at_ms");
        const dockerJson = readOptionalString(row, "docker_json");
        const unreadReason = readOptionalString(row, "unread_reason");
        const unreadSince = readOptionalNumber(row, "unread_since_ms");
        const workspaceId = readOptionalString(row, "workspace_id");
        return {
            id: readString(row, "id"),
            archived: readNumber(row, "archived") !== 0,
            projectId: readString(row, "project_id"),
            orderKey: readString(row, "order_key"),
            ...(workspaceId === undefined ? {} : { workspaceId }),
            trackUnread: readNumber(row, "track_unread") !== 0,
            ...(unreadReason !== undefined && unreadSince !== undefined
                ? { unread: { reason: unreadReason as SessionUnreadReason, since: unreadSince } }
                : {}),
            cwd: readString(row, "cwd"),
            ...(draft === undefined ? {} : { draft }),
            ...(draftUpdatedAt === undefined ? {} : { draftUpdatedAt }),
            providerId: readString(row, "provider_id"),
            modelId: readString(row, "model_id"),
            permissionMode: parsePermissionMode(readString(row, "permission_mode")),
            environment: summarizeDockerExecution(
                dockerJson === undefined
                    ? undefined
                    : (JSON.parse(dockerJson) as DockerExecutionConfig),
            ),
            ...(effort !== undefined ? { effort } : {}),
            ...(serviceTier === "fast" ? { serviceTier } : {}),
            status: readString(row, "status") as SessionSummary["status"],
            titleStatus: readString(row, "title_status") as SessionTitleStatus,
            createdAt: readNumber(row, "created_at_ms"),
            updatedAt: readNumber(row, "updated_at_ms"),
            ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
            ...(lastEventId !== undefined ? { lastEventId } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(titleError !== undefined ? { titleError } : {}),
            ...(recap !== undefined ? { recap } : {}),
            ...(sessionTokenCountJson === undefined
                ? {}
                : { sessionTokenCount: JSON.parse(sessionTokenCountJson) as SessionTokenCount }),
            ...(metadataUpdatedAt !== undefined ? { metadataUpdatedAt } : {}),
            ...(metadataRunId !== undefined ? { metadataRunId } : {}),
            ...(interruptionJson === undefined
                ? {}
                : { interruption: JSON.parse(interruptionJson) as SessionInterruption }),
        };
    });
}
