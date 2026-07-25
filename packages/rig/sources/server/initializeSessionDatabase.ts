import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { DatabaseSync } from "node:sqlite";

import { createId } from "@paralleldrive/cuid2";

import { normalizeProjectCwd } from "./normalizeProjectCwd.js";
import {
    folderProjectName,
    projectNameKey,
    projectStorageKey,
} from "./projectIdentity.js";
import { initializePersistentGlobalEventQueueSchema } from "./PersistentGlobalEventQueue.js";

const CURRENT_SCHEMA_VERSION = 7;

const sessionColumnMigrations = [
    ["project_id", "TEXT"],
    ["workspace_id", "TEXT"],
    ["title", "TEXT"],
    ["docker_json", "TEXT"],
    ["secret_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["title_status", "TEXT NOT NULL DEFAULT 'idle'"],
    ["title_error", "TEXT"],
    ["recap", "TEXT"],
    ["metadata_updated_at_ms", "INTEGER"],
    ["metadata_run_id", "TEXT"],
    ["last_message_at_ms", "INTEGER"],
    ["session_kind", "TEXT NOT NULL DEFAULT 'primary'"],
    ["parent_session_id", "TEXT"],
    ["root_session_id", "TEXT"],
    ["depth", "INTEGER NOT NULL DEFAULT 0"],
    ["parent_tool_call_id", "TEXT"],
    ["task_name", "TEXT"],
    ["description", "TEXT"],
    ["archive_on_idle", "INTEGER NOT NULL DEFAULT 0"],
    ["archived", "INTEGER NOT NULL DEFAULT 0"],
    ["track_unread", "INTEGER NOT NULL DEFAULT 0"],
    ["unread_reason", "TEXT"],
    ["unread_since_ms", "INTEGER"],
    ["active_since_ms", "INTEGER"],
    ["elapsed_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["total_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ["session_token_count_json", "TEXT"],
    ["usage_json", "TEXT"],
    ["context_messages_json", "TEXT"],
    ["service_tier", "TEXT"],
    ["append_system_prompt", "TEXT"],
    ["system_prompt", "TEXT"],
    ["external_tools_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["durable_skills_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["permission_mode", "TEXT NOT NULL DEFAULT 'workspace_write'"],
    ["tasks_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["workflows_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["workflows_enabled", "INTEGER NOT NULL DEFAULT 1"],
    ["goal_json", "TEXT"],
    ["next_task_id", "INTEGER NOT NULL DEFAULT 1"],
] as const;

const queuedRunColumnMigrations = [
    ["kind", "TEXT NOT NULL DEFAULT 'user'"],
    ["debug", "INTEGER NOT NULL DEFAULT 0"],
    ["debug_directory", "TEXT"],
    ["integration_config_json", "TEXT"],
] as const;

export function initializeSessionDatabase(database: DatabaseSync): void {
    database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
    `);

    database.exec("BEGIN IMMEDIATE");
    try {
        const versionRow = database.prepare("PRAGMA user_version").get() as
            | { user_version?: bigint | number }
            | undefined;
        const schemaVersion = Number(versionRow?.user_version ?? 0);
        const legacyProjectSecrets =
            schemaVersion > 0 &&
            schemaVersion < 7 &&
            database
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_secret_attachments'",
                )
                .get() !== undefined
                ? database
                      .prepare("SELECT cwd, secret_id FROM project_secret_attachments")
                      .all()
                      .map((row) => ({
                          cwd: readString(row, "cwd"),
                          secretId: readString(row, "secret_id"),
                      }))
                : [];
        const legacyGlobalEventTable =
            schemaVersion > 0 &&
            schemaVersion < 7 &&
            database
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'durable_global_events'",
                )
                .get() !== undefined &&
            database
                .prepare("PRAGMA table_info(durable_global_events)")
                .all()
                .some((column) => column.name === "cursor");
        const legacyGlobalEventState =
            legacyGlobalEventTable &&
            database
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'durable_global_event_queue_state'",
                )
                .get() !== undefined
                ? database
                      .prepare(
                          "SELECT last_cursor, trimmed_through FROM durable_global_event_queue_state WHERE id = 1",
                      )
                      .get()
                : undefined;
        if (schemaVersion > CURRENT_SCHEMA_VERSION) {
            throw new Error(
                `The session database uses schema version ${String(schemaVersion)}, but this Rig version supports up to ${String(CURRENT_SCHEMA_VERSION)}.`,
            );
        }
        if (schemaVersion > 0 && schemaVersion < 7) {
            if (legacyGlobalEventTable) {
                database.exec(
                    "ALTER TABLE durable_global_events RENAME TO legacy_durable_global_events_v5",
                );
            }
            database.exec(`
                DROP TABLE IF EXISTS durable_global_events;
                DROP TABLE IF EXISTS durable_global_event_queue_state;
                DROP TABLE IF EXISTS durable_global_event_streams;
                DROP TABLE IF EXISTS project_secret_attachments;
            `);
        }

        database.exec(`
            CREATE TABLE IF NOT EXISTS project_avatar_assets (
                hash TEXT PRIMARY KEY,
                media_type TEXT NOT NULL,
                byte_length INTEGER NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                dereferenced_at_ms INTEGER
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                storage_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                name_key TEXT NOT NULL UNIQUE,
                name_source TEXT NOT NULL,
                avatar_hash TEXT REFERENCES project_avatar_assets(hash),
                avatar_source TEXT,
                initialization_status TEXT NOT NULL,
                initialization_error TEXT,
                initialization_attempt INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_workspaces (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id),
                path TEXT NOT NULL UNIQUE,
                storage_key TEXT NOT NULL COLLATE NOCASE,
                name TEXT NOT NULL,
                name_key TEXT NOT NULL,
                kind TEXT NOT NULL,
                status TEXT NOT NULL,
                base_ref TEXT,
                branch TEXT,
                git_common_dir TEXT NOT NULL,
                error TEXT,
                client_request_id TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                archived_at_ms INTEGER,
                UNIQUE (project_id, storage_key),
                UNIQUE (project_id, name_key),
                UNIQUE (project_id, client_request_id)
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                project_id TEXT REFERENCES projects(id),
                workspace_id TEXT REFERENCES project_workspaces(id),
                session_kind TEXT NOT NULL DEFAULT 'primary',
                parent_session_id TEXT,
                root_session_id TEXT,
                depth INTEGER NOT NULL DEFAULT 0,
                parent_tool_call_id TEXT,
                task_name TEXT,
                description TEXT,
                archive_on_idle INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                track_unread INTEGER NOT NULL DEFAULT 0,
                unread_reason TEXT,
                unread_since_ms INTEGER,
                cwd TEXT NOT NULL,
                docker_json TEXT,
                secret_ids_json TEXT NOT NULL DEFAULT '[]',
                provider_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                effort TEXT,
                service_tier TEXT,
                instructions TEXT,
                append_system_prompt TEXT,
                system_prompt TEXT,
                external_tools_json TEXT NOT NULL DEFAULT '[]',
                durable_skills_json TEXT NOT NULL DEFAULT '[]',
                status TEXT NOT NULL,
                active_run_id TEXT,
                active_since_ms INTEGER,
                elapsed_ms INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                session_token_count_json TEXT,
                usage_json TEXT,
                last_event_id TEXT,
                permission_mode TEXT NOT NULL DEFAULT 'workspace_write',
                context_messages_json TEXT,
                models_json TEXT NOT NULL,
                tools_json TEXT NOT NULL,
                tasks_json TEXT NOT NULL DEFAULT '[]',
                workflows_json TEXT NOT NULL DEFAULT '[]',
                workflows_enabled INTEGER NOT NULL DEFAULT 1,
                goal_json TEXT,
                next_task_id INTEGER NOT NULL DEFAULT 1,
                title TEXT,
                title_status TEXT NOT NULL DEFAULT 'idle',
                title_error TEXT,
                recap TEXT,
                metadata_updated_at_ms INTEGER,
                metadata_run_id TEXT,
                interrupted INTEGER NOT NULL DEFAULT 0,
                interruption_json TEXT,
                last_message_at_ms INTEGER,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                event_id TEXT NOT NULL UNIQUE,
                type TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                data_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_messages (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                message_id TEXT NOT NULL,
                role TEXT NOT NULL,
                is_partial INTEGER NOT NULL DEFAULT 0,
                run_id TEXT,
                message_json TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (session_id, position)
            );

            CREATE TABLE IF NOT EXISTS queued_runs (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                run_id TEXT NOT NULL,
                debug INTEGER NOT NULL DEFAULT 0,
                debug_directory TEXT,
                display_text TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'user',
                text TEXT NOT NULL,
                user_message_json TEXT NOT NULL,
                integration_config_json TEXT,
                created_at_ms INTEGER NOT NULL,
                PRIMARY KEY (session_id, run_id)
            );

            CREATE TABLE IF NOT EXISTS external_tool_calls (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                run_id TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                tool_call_id TEXT NOT NULL,
                tool_call_index INTEGER NOT NULL,
                definition_json TEXT NOT NULL,
                skill_json TEXT,
                arguments_json TEXT NOT NULL,
                status TEXT NOT NULL,
                resolution_json TEXT,
                consumed INTEGER NOT NULL DEFAULT 0,
                created_at_ms INTEGER NOT NULL,
                resolved_at_ms INTEGER
            );

            CREATE TABLE IF NOT EXISTS durable_user_inputs (
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                request_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                tool_call_id TEXT NOT NULL,
                tool_call_index INTEGER NOT NULL,
                tool_name TEXT NOT NULL,
                tool_arguments_json TEXT NOT NULL,
                kind TEXT NOT NULL,
                permission_json TEXT,
                request_json TEXT NOT NULL,
                response_json TEXT,
                result_json TEXT,
                status TEXT NOT NULL,
                consumed INTEGER NOT NULL DEFAULT 0,
                created_at_ms INTEGER NOT NULL,
                resolved_at_ms INTEGER,
                PRIMARY KEY (session_id, request_id)
            );

            CREATE TABLE IF NOT EXISTS secret_registrations (
                id TEXT PRIMARY KEY,
                description TEXT NOT NULL,
                environment_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS secret_environment_variables (
                secret_id TEXT NOT NULL REFERENCES secret_registrations(id) ON DELETE CASCADE,
                normalized_name TEXT NOT NULL,
                name TEXT NOT NULL,
                PRIMARY KEY (secret_id, normalized_name)
            );

            CREATE TABLE IF NOT EXISTS project_secret_attachments (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                secret_id TEXT NOT NULL REFERENCES secret_registrations(id) ON DELETE CASCADE,
                PRIMARY KEY (project_id, secret_id)
            );

            CREATE TABLE IF NOT EXISTS happy_sessions (
                session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                credential_fingerprint TEXT NOT NULL,
                tag TEXT NOT NULL,
                remote_session_id TEXT,
                encryption_variant TEXT NOT NULL,
                encryption_key_base64 TEXT NOT NULL,
                last_remote_seq INTEGER NOT NULL DEFAULT 0,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS happy_outbox (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                local_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                UNIQUE (session_id, local_id)
            );
        `);

        if (legacyGlobalEventTable) {
            const streamId = createId();
            const legacyEventRange = database
                .prepare(
                    `
                    SELECT MIN(cursor) AS first_cursor, MAX(cursor) AS last_cursor
                    FROM legacy_durable_global_events_v5
                    `,
                )
                .get();
            const firstLegacyCursor = readOptionalNumber(legacyEventRange, "first_cursor");
            const lastLegacyCursor = readOptionalNumber(legacyEventRange, "last_cursor") ?? 0;
            const lastPosition =
                legacyGlobalEventState === undefined
                    ? lastLegacyCursor
                    : Math.max(
                          lastLegacyCursor,
                          readNumber(legacyGlobalEventState, "last_cursor"),
                      );
            const trimmedThrough =
                legacyGlobalEventState === undefined
                    ? Math.max(0, (firstLegacyCursor ?? 1) - 1)
                    : readNumber(legacyGlobalEventState, "trimmed_through");
            initializePersistentGlobalEventQueueSchema(database);
            database
                .prepare(
                    `
                    INSERT INTO durable_global_event_streams (
                        stream_id, last_position, trimmed_through, created_at_ms
                    ) VALUES (?, ?, ?, ?)
                    `,
                )
                .run(streamId, lastPosition, trimmedThrough, Date.now());
            database
                .prepare(
                    `
                    INSERT INTO durable_global_events (
                        position, stream_id, event_id, aggregate_kind, aggregate_id,
                        type, created_at_ms, data_json
                    )
                    SELECT
                        cursor, ?, event_id, 'session', session_id, type, created_at_ms,
                        json_object(
                            'createdAt', created_at_ms,
                            'data', json(data_json),
                            'id', event_id,
                            'sessionId', session_id,
                            'type', type
                        )
                    FROM legacy_durable_global_events_v5
                    ORDER BY cursor
                    `,
                )
                .run(streamId);
            database.exec("DROP TABLE legacy_durable_global_events_v5");
        }

        const sessionColumns = new Set(
            database
                .prepare("PRAGMA table_info(sessions)")
                .all()
                .map((column) => String(column.name)),
        );
        for (const [name, definition] of sessionColumnMigrations) {
            if (sessionColumns.has(name)) continue;
            database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
        }

        const historicalSessions = database
            .prepare(
                "SELECT DISTINCT cwd FROM sessions WHERE project_id IS NULL ORDER BY created_at_ms ASC",
            )
            .all();
        const canonicalHome = normalizeProjectCwd(homedir());
        for (const row of historicalSessions) {
            const originalCwd = readString(row, "cwd");
            const path = normalizeProjectCwd(originalCwd);
            const projectId = ensureProject(database, path, canonicalHome);
            database
                .prepare("UPDATE sessions SET project_id = ? WHERE project_id IS NULL AND cwd = ?")
                .run(projectId, originalCwd);
        }
        for (const attachment of legacyProjectSecrets) {
            const projectId = ensureProject(
                database,
                normalizeProjectCwd(attachment.cwd),
                canonicalHome,
            );
            database
                .prepare(
                    "INSERT OR IGNORE INTO project_secret_attachments (project_id, secret_id) VALUES (?, ?)",
                )
                .run(projectId, attachment.secretId);
        }

        const queuedRunColumns = new Set(
            database
                .prepare("PRAGMA table_info(queued_runs)")
                .all()
                .map((column) => String(column.name)),
        );
        for (const [name, definition] of queuedRunColumnMigrations) {
            if (queuedRunColumns.has(name)) continue;
            database.exec(`ALTER TABLE queued_runs ADD COLUMN ${name} ${definition}`);
        }

        const externalToolCallColumns = new Set(
            database
                .prepare("PRAGMA table_info(external_tool_calls)")
                .all()
                .map((column) => String(column.name)),
        );
        if (!externalToolCallColumns.has("skill_json")) {
            database.exec("ALTER TABLE external_tool_calls ADD COLUMN skill_json TEXT");
        }

        database.exec(`
            CREATE INDEX IF NOT EXISTS session_events_session_seq
                ON session_events(session_id, seq);
            CREATE INDEX IF NOT EXISTS session_messages_session_message
                ON session_messages(session_id, message_id);
            CREATE INDEX IF NOT EXISTS sessions_parent_created
                ON sessions(parent_session_id, created_at_ms);
            CREATE INDEX IF NOT EXISTS sessions_project_activity
                ON sessions(project_id, last_message_at_ms DESC, updated_at_ms DESC);
            CREATE INDEX IF NOT EXISTS sessions_workspace_activity
                ON sessions(workspace_id, last_message_at_ms DESC, updated_at_ms DESC);
            CREATE INDEX IF NOT EXISTS projects_updated
                ON projects(updated_at_ms DESC);
            CREATE INDEX IF NOT EXISTS project_workspaces_project_updated
                ON project_workspaces(project_id, updated_at_ms DESC);
            CREATE INDEX IF NOT EXISTS external_tool_calls_session_created
                ON external_tool_calls(session_id, created_at_ms);
            CREATE INDEX IF NOT EXISTS durable_user_inputs_session_created
                ON durable_user_inputs(session_id, created_at_ms);
            CREATE INDEX IF NOT EXISTS happy_outbox_session_seq
                ON happy_outbox(session_id, seq);
            PRAGMA user_version = ${String(CURRENT_SCHEMA_VERSION)};
            COMMIT;
        `);
    } catch (error) {
        try {
            database.exec("ROLLBACK");
        } catch {
            // Keep the migration failure as the actionable startup error.
        }
        throw error;
    }
}

function ensureProject(
    database: DatabaseSync,
    path: string,
    canonicalHome: string,
): string {
    const existing = database.prepare("SELECT id FROM projects WHERE path = ?").get(path);
    if (existing !== undefined) return readString(existing, "id");

    const kind = path === canonicalHome ? "home" : "regular";
    const baseName = kind === "home" ? "Home" : folderProjectName(path);
    const name = reserveName(database, baseName);
    const storageKey = reserveStorageKey(
        database,
        kind === "home" ? "home" : projectStorageKey(baseName),
    );
    const now = Date.now();
    const available = kind === "home" || existsSync(path);
    const id = createId();
    database
        .prepare(
            `
            INSERT INTO projects (
                id, path, storage_key, kind, name, name_key, name_source,
                initialization_status, initialization_error,
                initialization_attempt, version, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, 'folder', ?, ?, 0, 1, ?, ?)
            `,
        )
        .run(
            id,
            path,
            storageKey,
            kind,
            name,
            projectNameKey(name),
            available && kind === "regular"
                ? "initializing"
                : available
                  ? "ready"
                  : "failed",
            available ? null : "Project directory is unavailable.",
            now,
            now,
        );
    return id;
}

function reserveName(database: DatabaseSync, base: string): string {
    for (let suffix = 1; ; suffix += 1) {
        const candidate = suffix === 1 ? base : `${base} (${String(suffix)})`;
        if (
            database.prepare("SELECT 1 FROM projects WHERE name_key = ?").get(
                projectNameKey(candidate),
            ) === undefined
        ) {
            return candidate;
        }
    }
}

function reserveStorageKey(database: DatabaseSync, base: string): string {
    for (let suffix = 1; ; suffix += 1) {
        const candidate = suffix === 1 ? base : `${base}-${String(suffix)}`;
        if (
            database
                .prepare("SELECT 1 FROM projects WHERE storage_key = ? COLLATE NOCASE")
                .get(candidate) === undefined
        ) {
            return candidate;
        }
    }
}

function readString(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    if (typeof value !== "string") throw new Error(`Expected text SQLite column '${key}'.`);
    return value;
}

function readNumber(row: Record<string, unknown>, key: string): number {
    const value = row[key];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    throw new Error(`Expected numeric SQLite column '${key}'.`);
}

function readOptionalNumber(
    row: Record<string, unknown> | undefined,
    key: string,
): number | undefined {
    if (row === undefined) return undefined;
    const value = row[key];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    return undefined;
}
