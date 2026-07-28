import { DatabaseSync } from "node:sqlite";

const REQUIRED_COLUMNS = {
    project_workspaces: ["archived_at_ms", "order_key", "project_id", "status"],
    projects: ["archived_at_ms", "order_key"],
    session_events: ["data_json", "event_id", "session_id"],
    session_messages: ["message_json", "message_id", "session_id"],
    sessions: ["archived", "parent_session_id", "project_id", "session_kind", "workspace_id"],
} as const;

export interface RigDatabaseCatalog {
    activeProjectIds: readonly string[];
    activeRootSessionIds: readonly string[];
    activeWorkspaceIds: readonly string[];
    projectIds: readonly string[];
    rootSessionIds: readonly string[];
}

export interface RigDatabaseInspection {
    counts: {
        activeProjects: number;
        activeRootSessions: number;
        activeWorkspaces: number;
        projects: number;
        rootSessions: number;
        sessionEvents: number;
        sessionMessages: number;
        sessions: number;
        workspaces: number;
    };
    foreignKeyViolations: number;
    integrity: string;
    invalidJsonRows: number;
    missingColumns: readonly string[];
    schemaVersion: number;
}

export interface RigDatabaseStartupState {
    maxEventSequence: number;
    runningAutoArchiveSessions: number;
    runningSessionIds: readonly string[];
}

export function inspectRigDatabase(
    databasePath: string,
    options: { fullIntegrityCheck?: boolean } = {},
): RigDatabaseInspection {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        database.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;");
        const missingColumns = Object.entries(REQUIRED_COLUMNS).flatMap(
            ([table, requiredColumns]) => {
                const columns = new Set(
                    database
                        .prepare(`PRAGMA table_info(${table})`)
                        .all()
                        .map((row) => readString(row, "name")),
                );
                return requiredColumns
                    .filter((column) => !columns.has(column))
                    .map((column) => `${table}.${column}`);
            },
        );
        const integrityPragma =
            options.fullIntegrityCheck === true ? "integrity_check" : "quick_check";
        const integrityRow = database.prepare(`PRAGMA ${integrityPragma}(1)`).get();
        const integrity = readString(integrityRow, integrityPragma);
        const foreignKeyViolations = database
            .prepare("SELECT COUNT(*) AS count FROM pragma_foreign_key_check")
            .get();
        const invalidJsonRows = database
            .prepare(
                `
                SELECT
                    (SELECT COUNT(*) FROM session_events WHERE NOT json_valid(data_json)) +
                    (SELECT COUNT(*) FROM session_messages WHERE NOT json_valid(message_json)) +
                    (SELECT COUNT(*) FROM sessions WHERE NOT json_valid(models_json)) +
                    (SELECT COUNT(*) FROM sessions WHERE NOT json_valid(tools_json))
                    AS count
                `,
            )
            .get();

        return {
            counts: {
                activeProjects: count(
                    database,
                    "SELECT COUNT(*) AS count FROM projects WHERE archived_at_ms IS NULL",
                ),
                activeRootSessions: count(
                    database,
                    `
                    SELECT COUNT(*) AS count
                    FROM sessions
                    WHERE parent_session_id IS NULL
                        AND archived = 0
                        AND (
                            archive_on_idle = 0
                            OR status IN ('queued', 'running')
                        )
                    `,
                ),
                activeWorkspaces: count(
                    database,
                    `
                    SELECT COUNT(*) AS count
                    FROM project_workspaces
                    JOIN projects ON projects.id = project_workspaces.project_id
                    WHERE projects.archived_at_ms IS NULL
                        AND project_workspaces.archived_at_ms IS NULL
                        AND project_workspaces.status != 'archived'
                    `,
                ),
                projects: count(database, "SELECT COUNT(*) AS count FROM projects"),
                rootSessions: count(
                    database,
                    "SELECT COUNT(*) AS count FROM sessions WHERE parent_session_id IS NULL",
                ),
                sessionEvents: count(database, "SELECT COUNT(*) AS count FROM session_events"),
                sessionMessages: count(database, "SELECT COUNT(*) AS count FROM session_messages"),
                sessions: count(database, "SELECT COUNT(*) AS count FROM sessions"),
                workspaces: count(database, "SELECT COUNT(*) AS count FROM project_workspaces"),
            },
            foreignKeyViolations: readNumber(foreignKeyViolations, "count"),
            integrity,
            invalidJsonRows: readNumber(invalidJsonRows, "count"),
            missingColumns,
            schemaVersion: readNumber(
                database.prepare("PRAGMA user_version").get(),
                "user_version",
            ),
        };
    } finally {
        database.close();
    }
}

export function readRigDatabaseCatalog(databasePath: string): RigDatabaseCatalog {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        database.exec("PRAGMA query_only = ON;");
        return {
            activeProjectIds: readIds(
                database,
                "SELECT id FROM projects WHERE archived_at_ms IS NULL ORDER BY id",
            ),
            activeRootSessionIds: readIds(
                database,
                `
                SELECT id
                FROM sessions
                WHERE parent_session_id IS NULL
                    AND archived = 0
                    AND (
                        archive_on_idle = 0
                        OR status IN ('queued', 'running')
                    )
                ORDER BY id
                `,
            ),
            activeWorkspaceIds: readIds(
                database,
                `
                SELECT project_workspaces.id
                FROM project_workspaces
                JOIN projects ON projects.id = project_workspaces.project_id
                WHERE projects.archived_at_ms IS NULL
                    AND project_workspaces.archived_at_ms IS NULL
                    AND project_workspaces.status != 'archived'
                ORDER BY project_workspaces.id
                `,
            ),
            projectIds: readIds(database, "SELECT id FROM projects ORDER BY id"),
            rootSessionIds: readIds(
                database,
                "SELECT id FROM sessions WHERE parent_session_id IS NULL ORDER BY id",
            ),
        };
    } finally {
        database.close();
    }
}

export function readRigDatabaseStartupState(databasePath: string): RigDatabaseStartupState {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        database.exec("PRAGMA query_only = ON;");
        return {
            maxEventSequence: readNumber(
                database
                    .prepare("SELECT COALESCE(MAX(seq), 0) AS sequence FROM session_events")
                    .get(),
                "sequence",
            ),
            runningAutoArchiveSessions: count(
                database,
                "SELECT COUNT(*) AS count FROM sessions WHERE status = 'running' AND archive_on_idle = 1",
            ),
            runningSessionIds: readIds(
                database,
                "SELECT id FROM sessions WHERE status = 'running' ORDER BY id",
            ),
        };
    } finally {
        database.close();
    }
}

export function assertExpectedRigDatabaseStartupChanges(
    databasePath: string,
    before: RigDatabaseStartupState,
): void {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        database.exec("PRAGMA query_only = ON;");
        const expectedSessionIds = new Set(before.runningSessionIds);
        const rows = database
            .prepare(
                `
                SELECT session_id, type
                FROM session_events
                WHERE seq > ?
                ORDER BY seq
                `,
            )
            .all(before.maxEventSequence);
        const expectedEventCount = expectedSessionIds.size * 2;
        if (rows.length !== expectedEventCount) {
            throw new Error(
                `Startup appended ${String(rows.length)} session events; expected ${String(expectedEventCount)} recovery events.`,
            );
        }
        const eventTypesBySession = new Map<string, string[]>();
        for (const row of rows) {
            const sessionId = readString(row, "session_id");
            if (!expectedSessionIds.has(sessionId)) {
                throw new Error("Startup appended an event to a session that was not running.");
            }
            const eventTypes = eventTypesBySession.get(sessionId) ?? [];
            eventTypes.push(readString(row, "type"));
            eventTypesBySession.set(sessionId, eventTypes);
        }
        for (const sessionId of expectedSessionIds) {
            const eventTypes = [...(eventTypesBySession.get(sessionId) ?? [])].sort();
            if (
                eventTypes.length !== 2 ||
                eventTypes[0] !== "run_error" ||
                eventTypes[1] !== "session_status_changed"
            ) {
                throw new Error(
                    "Startup did not record the expected recovery events for a running session.",
                );
            }
            const row = database.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionId);
            if (readString(row, "status") !== "error") {
                throw new Error("Startup did not recover a running session to error.");
            }
        }
    } finally {
        database.close();
    }
}

function count(database: DatabaseSync, sql: string): number {
    return readNumber(database.prepare(sql).get(), "count");
}

function readIds(database: DatabaseSync, sql: string): string[] {
    return database
        .prepare(sql)
        .all()
        .map((row) => readString(row, "id"));
}

function readNumber(row: Record<string, unknown> | undefined, key: string): number {
    const value = row?.[key];
    if (typeof value !== "number" && typeof value !== "bigint") {
        throw new Error(`The database did not return a numeric ${key}.`);
    }
    return Number(value);
}

function readString(row: Record<string, unknown> | undefined, key: string): string {
    const value = row?.[key];
    if (typeof value !== "string") {
        throw new Error(`The database did not return a text ${key}.`);
    }
    return value;
}
