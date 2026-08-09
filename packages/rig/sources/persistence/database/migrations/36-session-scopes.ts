import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * Makes a chat's project, workspace, folder, or Unsorted membership exclusive.
 *
 * Existing folder membership wins over Unsorted, which wins over workspace and project. This is
 * the order users already see when an older row carries more than one of the legacy columns.
 */
export async function sessionScopes(database: SessionDatabase): Promise<void> {
    const sessions = (
        await database.all<{ name: string }>(
            sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
        )
    )[0];
    if (sessions === undefined) {
        await createFolderCatalog(database);
        return;
    }
    await database.run(
        sql.raw(`
        CREATE TABLE sessions_scoped (
            id TEXT NOT NULL PRIMARY KEY,
            agent_id TEXT NOT NULL,
            scope_kind TEXT NOT NULL DEFAULT 'project',
            project_id TEXT REFERENCES projects(id),
            workspace_id TEXT REFERENCES project_workspaces(id),
            folder_id TEXT REFERENCES folders(id),
            order_key TEXT NOT NULL COLLATE BINARY,
            session_kind TEXT NOT NULL,
            parent_session_id TEXT,
            root_session_id TEXT NOT NULL,
            depth INTEGER NOT NULL,
            parent_tool_call_id TEXT,
            task_name TEXT,
            description TEXT,
            archived INTEGER NOT NULL,
            track_unread INTEGER NOT NULL,
            unread_reason TEXT,
            unread_since_ms INTEGER,
            cwd TEXT NOT NULL,
            draft TEXT,
            draft_updated_at_ms INTEGER,
            docker_json TEXT,
            secret_ids_json TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            effort TEXT,
            service_tier TEXT,
            instructions TEXT,
            append_system_prompt TEXT,
            system_prompt TEXT,
            external_tools_json TEXT NOT NULL,
            durable_skills_json TEXT NOT NULL,
            status TEXT NOT NULL,
            active_run_id TEXT,
            active_since_ms INTEGER,
            elapsed_ms INTEGER NOT NULL,
            total_tokens INTEGER NOT NULL,
            session_token_count_json TEXT,
            usage_json TEXT,
            last_event_id TEXT,
            permission_mode TEXT NOT NULL,
            models_json TEXT NOT NULL,
            tools_json TEXT NOT NULL,
            tasks_json TEXT NOT NULL,
            workflows_json TEXT NOT NULL,
            workflows_enabled INTEGER NOT NULL,
            goal_json TEXT,
            next_task_id INTEGER NOT NULL,
            title TEXT,
            title_status TEXT NOT NULL,
            title_error TEXT,
            recap TEXT,
            metadata_updated_at_ms INTEGER,
            metadata_run_id TEXT,
            interrupted INTEGER NOT NULL,
            interruption_json TEXT,
            last_message_at_ms INTEGER,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            delegated_by_session_id TEXT,
            lifetime_total_tokens INTEGER NOT NULL DEFAULT 0,
            workspace_transfer_json TEXT NOT NULL DEFAULT '{"status":"idle"}',
            workspace_queue_waiting INTEGER NOT NULL DEFAULT 0,
            unsorted_since_ms INTEGER,
            CHECK (
                (scope_kind = 'project'
                    AND project_id IS NOT NULL
                    AND workspace_id IS NULL
                    AND folder_id IS NULL
                    AND unsorted_since_ms IS NULL)
                OR
                (scope_kind = 'workspace'
                    AND project_id IS NOT NULL
                    AND workspace_id IS NOT NULL
                    AND folder_id IS NULL
                    AND unsorted_since_ms IS NULL)
                OR
                (scope_kind = 'folder'
                    AND project_id IS NULL
                    AND workspace_id IS NULL
                    AND folder_id IS NOT NULL
                    AND unsorted_since_ms IS NULL)
                OR
                (scope_kind = 'unsorted'
                    AND project_id IS NULL
                    AND workspace_id IS NULL
                    AND folder_id IS NULL
                    AND unsorted_since_ms IS NOT NULL)
            )
        )
    `),
    );
    await database.run(
        sql.raw(`
        INSERT INTO sessions_scoped (
            id, agent_id, scope_kind, project_id, workspace_id, folder_id, order_key,
            session_kind, parent_session_id, root_session_id, depth, parent_tool_call_id,
            task_name, description, archived, track_unread, unread_reason, unread_since_ms,
            cwd, draft, draft_updated_at_ms, docker_json, secret_ids_json, provider_id,
            model_id, effort, service_tier, instructions, append_system_prompt, system_prompt,
            external_tools_json, durable_skills_json, status, active_run_id, active_since_ms,
            elapsed_ms, total_tokens, session_token_count_json, usage_json, last_event_id,
            permission_mode, models_json, tools_json, tasks_json, workflows_json,
            workflows_enabled, goal_json, next_task_id, title, title_status, title_error,
            recap, metadata_updated_at_ms, metadata_run_id, interrupted, interruption_json,
            last_message_at_ms, created_at_ms, updated_at_ms, delegated_by_session_id,
            lifetime_total_tokens, workspace_transfer_json, workspace_queue_waiting,
            unsorted_since_ms
        )
        SELECT
            id,
            agent_id,
            CASE
                WHEN folder_id IS NOT NULL THEN 'folder'
                WHEN unsorted_since_ms IS NOT NULL THEN 'unsorted'
                WHEN workspace_id IS NOT NULL THEN 'workspace'
                ELSE 'project'
            END,
            CASE
                WHEN folder_id IS NOT NULL OR unsorted_since_ms IS NOT NULL THEN NULL
                ELSE project_id
            END,
            CASE
                WHEN folder_id IS NOT NULL OR unsorted_since_ms IS NOT NULL THEN NULL
                ELSE workspace_id
            END,
            folder_id,
            order_key, session_kind, parent_session_id, root_session_id, depth,
            parent_tool_call_id, task_name, description, archived, track_unread,
            unread_reason, unread_since_ms, cwd, draft, draft_updated_at_ms, docker_json,
            secret_ids_json, provider_id, model_id, effort, service_tier, instructions,
            append_system_prompt, system_prompt, external_tools_json, durable_skills_json,
            status, active_run_id, active_since_ms, elapsed_ms, total_tokens,
            session_token_count_json, usage_json, last_event_id, permission_mode, models_json,
            tools_json, tasks_json, workflows_json, workflows_enabled, goal_json, next_task_id,
            title, title_status, title_error, recap, metadata_updated_at_ms, metadata_run_id,
            interrupted, interruption_json, last_message_at_ms, created_at_ms, updated_at_ms,
            delegated_by_session_id, lifetime_total_tokens, workspace_transfer_json,
            workspace_queue_waiting,
            CASE
                WHEN folder_id IS NULL AND unsorted_since_ms IS NOT NULL
                    THEN unsorted_since_ms
                ELSE NULL
            END
        FROM sessions
    `),
    );
    await database.run(sql.raw("DROP TABLE sessions"));
    await database.run(sql.raw("ALTER TABLE sessions_scoped RENAME TO sessions"));
    for (const statement of sessionIndexes) await database.run(sql.raw(statement));

    await createFolderCatalog(database);
}

async function createFolderCatalog(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        CREATE TABLE folder_catalog (
            id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL
        )
    `),
    );
    await database.run(sql.raw("INSERT INTO folder_catalog (id, revision) VALUES (1, 0)"));
    await database.run(
        sql.raw(`
        CREATE TABLE folder_mutations (
            mutation_id TEXT NOT NULL PRIMARY KEY,
            action TEXT NOT NULL,
            folder_id TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        )
    `),
    );
    await database.run(
        sql.raw(
            "CREATE INDEX folder_mutations_created ON folder_mutations(created_at_ms DESC, mutation_id DESC)",
        ),
    );
}

const sessionIndexes = [
    "CREATE INDEX sessions_agent_id ON sessions(agent_id)",
    "CREATE INDEX sessions_parent_created ON sessions(parent_session_id, created_at_ms)",
    "CREATE INDEX sessions_delegated_by ON sessions(delegated_by_session_id)",
    "CREATE INDEX sessions_delegated_created ON sessions(delegated_by_session_id, created_at_ms, id)",
    "CREATE INDEX sessions_project_activity ON sessions(project_id, last_message_at_ms DESC, updated_at_ms DESC)",
    "CREATE INDEX sessions_workspace_activity ON sessions(workspace_id, last_message_at_ms DESC, updated_at_ms DESC)",
    "CREATE INDEX sessions_project_order ON sessions(scope_kind, project_id, order_key) WHERE parent_session_id IS NULL",
    "CREATE INDEX sessions_workspace_order ON sessions(scope_kind, workspace_id, order_key) WHERE parent_session_id IS NULL",
    "CREATE INDEX sessions_folder_order ON sessions(scope_kind, folder_id, order_key) WHERE parent_session_id IS NULL",
    "CREATE INDEX sessions_folder ON sessions(folder_id, updated_at_ms DESC)",
    "CREATE INDEX sessions_unsorted_order ON sessions(scope_kind, order_key) WHERE parent_session_id IS NULL",
    "CREATE INDEX sessions_unsorted ON sessions(unsorted_since_ms) WHERE archived = 0",
] as const;
