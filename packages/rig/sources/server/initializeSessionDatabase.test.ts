import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { initializeSessionDatabase } from "./initializeSessionDatabase.js";
import { PersistentGlobalEventQueue } from "./PersistentGlobalEventQueue.js";

describe("initializeSessionDatabase", () => {
    it("adds durable archive state to version 5 session databases", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database.exec(`
                DROP TABLE project_secret_attachments;
                CREATE TABLE project_secret_attachments (
                    cwd TEXT NOT NULL,
                    secret_id TEXT NOT NULL,
                    PRIMARY KEY (cwd, secret_id)
                );
                ALTER TABLE sessions DROP COLUMN archived;
                PRAGMA user_version = 5;
            `);

            initializeSessionDatabase(database);

            expect(
                database
                    .prepare("PRAGMA table_info(sessions)")
                    .all()
                    .find((column) => column.name === "archived"),
            ).toMatchObject({ dflt_value: "0", notnull: 1, type: "INTEGER" });
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
        } finally {
            database.close();
        }
    });

    it("adds provider tool identity storage to version 10 databases", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database.exec(`
                ALTER TABLE external_tool_calls DROP COLUMN provider_tool_call_id;
                PRAGMA user_version = 10;
            `);

            initializeSessionDatabase(database);

            expect(
                columnInfo(database, "external_tool_calls", "provider_tool_call_id"),
            ).toBeDefined();
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
        } finally {
            database.close();
        }
    });

    it("adds provider tool identity storage to existing durable user input tables", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database.exec(`
                ALTER TABLE durable_user_inputs DROP COLUMN provider_tool_call_id;
                PRAGMA user_version = 10;
            `);

            initializeSessionDatabase(database);

            expect(
                columnInfo(database, "durable_user_inputs", "provider_tool_call_id"),
            ).toBeDefined();
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
        } finally {
            database.close();
        }
    });

    it("adds the inherited workspace title to earlier workspace databases", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database.exec(`
                ALTER TABLE project_workspaces DROP COLUMN title;
                PRAGMA user_version = 11;
            `);

            initializeSessionDatabase(database);

            expect(columnInfo(database, "project_workspaces", "title")).toMatchObject({
                notnull: 0,
                type: "TEXT",
            });
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
        } finally {
            database.close();
        }
    });

    it("applies migration 12 to existing version 11 transcript turns", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database
                .prepare(
                    `
                    INSERT INTO sessions (
                        id, agent_id, cwd, provider_id, model_id, status,
                        models_json, tools_json, created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                )
                .run(
                    "session-with-history",
                    "agent-1",
                    "/tmp/rig-history",
                    "codex",
                    "openai/gpt-test",
                    "idle",
                    "[]",
                    "[]",
                    1,
                    1,
                );
            const insertMessage = database.prepare(
                `
                INSERT INTO session_messages (
                    session_id, position, message_id, role, is_partial, run_id,
                    message_json, updated_at_ms
                ) VALUES (?, ?, ?, 'agent', ?, ?, ?, 1)
                `,
            );
            insertMessage.run(
                "session-with-history",
                0,
                "message-1",
                0,
                "run-1",
                JSON.stringify({ blocks: [], id: "message-1", role: "agent" }),
            );
            insertMessage.run(
                "session-with-history",
                1,
                "message-2",
                0,
                "run-1",
                JSON.stringify({ blocks: [], id: "message-2", role: "agent" }),
            );
            insertMessage.run(
                "session-with-history",
                2,
                "message-3",
                0,
                "run-2",
                JSON.stringify({ blocks: [], id: "message-3", role: "agent" }),
            );
            insertMessage.run(
                "session-with-history",
                3,
                "partial-message",
                1,
                "partial-run",
                JSON.stringify({ blocks: [], id: "partial-message", role: "agent" }),
            );
            database.exec(`
                DELETE FROM session_turns;
                DELETE FROM session_database_migrations WHERE version = 12;
                PRAGMA user_version = 11;
            `);
            const indexedTurns = () =>
                database
                    .prepare(
                        `
                        SELECT session_id, run_id, first_position
                        FROM session_turns
                        ORDER BY first_position
                        `,
                    )
                    .all();

            initializeSessionDatabase(database);

            expect(indexedTurns()).toEqual([
                {
                    first_position: 0,
                    run_id: "run-1",
                    session_id: "session-with-history",
                },
                {
                    first_position: 2,
                    run_id: "run-2",
                    session_id: "session-with-history",
                },
            ]);
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });

            // The schema version may already be committed when a later migration batch is
            // interrupted. Startup must resume migration 12 from its durable cursor.
            database
                .prepare("DELETE FROM session_turns WHERE session_id = ? AND run_id = ?")
                .run("session-with-history", "run-2");
            const completedBatch = database
                .prepare("SELECT rowid FROM session_messages WHERE session_id = ? AND position = ?")
                .get("session-with-history", 1) as { rowid: number };
            database
                .prepare(
                    `
                    UPDATE session_database_migrations
                    SET cursor = ?, completed = 0
                    WHERE version = 12
                    `,
                )
                .run(completedBatch.rowid);

            initializeSessionDatabase(database);

            expect(indexedTurns()).toHaveLength(2);
            expect(
                database
                    .prepare("SELECT completed FROM session_database_migrations WHERE version = 12")
                    .get(),
            ).toEqual({ completed: 1 });
        } finally {
            database.close();
        }
    });

    it("adds project archive state to earlier project databases", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database.exec(`
                ALTER TABLE projects DROP COLUMN archived_at_ms;
                PRAGMA user_version = 8;
            `);

            initializeSessionDatabase(database);

            expect(
                database
                    .prepare("PRAGMA table_info(projects)")
                    .all()
                    .find((column) => column.name === "archived_at_ms"),
            ).toMatchObject({ notnull: 0, type: "INTEGER" });
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
        } finally {
            database.close();
        }
    });

    it("migrates an older database that still has sessions without a project", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            for (const [table, columns] of [
                [
                    "projects",
                    [
                        "presence",
                        "worktree_support",
                        "worktree_support_reason",
                        "git_branch",
                        "git_head",
                        "git_upstream",
                        "git_ahead",
                        "git_behind",
                        "git_detached",
                    ],
                ],
                [
                    "project_workspaces",
                    [
                        "base_commit",
                        "presence",
                        "git_branch",
                        "git_head",
                        "git_upstream",
                        "git_ahead",
                        "git_behind",
                        "git_detached",
                    ],
                ],
            ] as const) {
                for (const column of columns) {
                    database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                }
            }
            database.exec("ALTER TABLE project_workspaces ADD COLUMN branch TEXT");
            // A legacy session with no project is what forces the backfill to insert a project
            // row, which is where column ordering during the migration becomes observable.
            database
                .prepare(
                    `
                    INSERT INTO sessions (
                        id, agent_id, cwd, provider_id, model_id, models_json, tools_json,
                        status, created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                )
                .run(
                    "legacy-session",
                    "codex",
                    "/tmp/rig-legacy",
                    "codex",
                    "gpt",
                    "[]",
                    "[]",
                    "idle",
                    1,
                    1,
                );
            database.exec("UPDATE sessions SET project_id = NULL");
            database.exec("PRAGMA user_version = 9");

            expect(() => initializeSessionDatabase(database)).not.toThrow();

            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
            const project = database
                .prepare("SELECT presence FROM projects WHERE path = ?")
                .get("/tmp/rig-legacy");
            expect(project).toMatchObject({ presence: "missing" });
        } finally {
            database.close();
        }
    });

    it("rolls back every schema change when a migration fails", () => {
        const database = new DatabaseSync(":memory:");
        try {
            database.exec(`
                CREATE TABLE sessions (id TEXT PRIMARY KEY);
                CREATE TABLE session_events (seq INTEGER PRIMARY KEY);
                PRAGMA user_version = 0;
            `);

            expect(() => initializeSessionDatabase(database)).toThrow();

            expect(
                database
                    .prepare("PRAGMA table_info(sessions)")
                    .all()
                    .map((column) => column.name),
            ).toEqual(["id"]);
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
            expect(
                database
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                    .all()
                    .map((row) => row.name),
            ).toEqual(["session_events", "sessions"]);
        } finally {
            database.close();
        }
    });

    it("refuses to open a database from a newer Rig schema", () => {
        const database = new DatabaseSync(":memory:");
        try {
            database.exec("PRAGMA user_version = 13");

            expect(() => initializeSessionDatabase(database)).toThrow(
                "The session database uses schema version 13, but this Rig version supports up to 12.",
            );
            expect(
                database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
            ).toEqual([]);
        } finally {
            database.close();
        }
    });

    it("backfills historical sessions into canonical projects", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database.exec(`
                DROP TABLE project_secret_attachments;
                CREATE TABLE project_secret_attachments (
                    cwd TEXT NOT NULL,
                    secret_id TEXT NOT NULL,
                    PRIMARY KEY (cwd, secret_id)
                );
                CREATE TABLE durable_global_events (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    data_json TEXT NOT NULL
                );
                CREATE TABLE durable_global_event_queue_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    last_cursor INTEGER NOT NULL,
                    trimmed_through INTEGER NOT NULL
                );
                INSERT INTO durable_global_event_queue_state
                    (id, last_cursor, trimmed_through)
                VALUES (1, 1, 0);
            `);
            database
                .prepare(
                    "INSERT INTO secret_registrations (id, description, environment_json) VALUES (?, ?, ?)",
                )
                .run("secret-1", "Fixture", "{}");
            database
                .prepare("INSERT INTO project_secret_attachments (cwd, secret_id) VALUES (?, ?)")
                .run("/tmp/rig-secret-only-project", "secret-1");
            database
                .prepare(
                    `
                    INSERT INTO sessions (
                        id, agent_id, cwd, provider_id, model_id, status,
                        models_json, tools_json, created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                )
                .run(
                    "session-1",
                    "agent-1",
                    "/tmp/rig-historical-project",
                    "codex",
                    "openai/gpt-test",
                    "idle",
                    "[]",
                    "[]",
                    1,
                    1,
                );
            database
                .prepare(
                    `
                    INSERT INTO sessions (
                        id, agent_id, cwd, provider_id, model_id, status,
                        models_json, tools_json, created_at_ms, updated_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                )
                .run(
                    "session-2",
                    "agent-2",
                    "/tmp/rig-historical-project",
                    "codex",
                    "openai/gpt-test",
                    "idle",
                    "[]",
                    "[]",
                    2,
                    2,
                );
            database
                .prepare(
                    `
                    INSERT INTO durable_global_events (
                        event_id, session_id, type, created_at_ms, data_json
                    ) VALUES (?, ?, ?, ?, ?)
                    `,
                )
                .run(
                    "event-1",
                    "session-1",
                    "session_created",
                    2,
                    JSON.stringify({ session: { id: "session-1" } }),
                );
            database.exec("PRAGMA user_version = 6");

            initializeSessionDatabase(database);

            expect(
                database
                    .prepare(
                        `
                        SELECT sessions.project_id, projects.path
                        FROM sessions
                        JOIN projects ON projects.id = sessions.project_id
                        WHERE sessions.id = 'session-1'
                        `,
                    )
                    .get(),
            ).toMatchObject({
                path: "/tmp/rig-historical-project",
                project_id: expect.any(String),
            });
            expect(
                database
                    .prepare(
                        `
                        SELECT id, order_key
                        FROM sessions
                        WHERE cwd = '/tmp/rig-historical-project'
                        ORDER BY order_key
                        `,
                    )
                    .all(),
            ).toEqual([
                { id: "session-2", order_key: "a0" },
                { id: "session-1", order_key: "a1" },
            ]);
            expect(
                database.prepare("SELECT order_key FROM projects ORDER BY order_key").all(),
            ).toEqual([{ order_key: "Zz" }, { order_key: "a0" }]);
            expect(
                database
                    .prepare(
                        `
                        SELECT projects.path
                        FROM project_secret_attachments
                        JOIN projects ON projects.id = project_secret_attachments.project_id
                        WHERE project_secret_attachments.secret_id = 'secret-1'
                        `,
                    )
                    .get(),
            ).toEqual({ path: "/tmp/rig-secret-only-project" });
            expect(new PersistentGlobalEventQueue(database).list()).toMatchObject([
                {
                    event: {
                        id: "event-1",
                        sessionId: "session-1",
                        type: "session_created",
                    },
                },
            ]);
        } finally {
            database.close();
        }
    });

    it("derives a missing legacy queue state from the migrated event range", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            database.exec(`
                DROP TABLE project_secret_attachments;
                CREATE TABLE project_secret_attachments (
                    cwd TEXT NOT NULL,
                    secret_id TEXT NOT NULL,
                    PRIMARY KEY (cwd, secret_id)
                );
                CREATE TABLE durable_global_events (
                    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_id TEXT NOT NULL UNIQUE,
                    session_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    data_json TEXT NOT NULL
                );
                INSERT INTO durable_global_events (
                    cursor, event_id, session_id, type, created_at_ms, data_json
                ) VALUES
                    (4, 'event-4', 'session-1', 'session_created', 4, '{}'),
                    (7, 'event-7', 'session-1', 'session_updated', 7, '{}');
                PRAGMA user_version = 6;
            `);

            initializeSessionDatabase(database);

            expect(
                database
                    .prepare(
                        "SELECT last_position, trimmed_through FROM durable_global_event_streams",
                    )
                    .get(),
            ).toEqual({ last_position: 7, trimmed_through: 3 });
            expect(
                database
                    .prepare("SELECT position FROM durable_global_events ORDER BY position")
                    .all(),
            ).toEqual([{ position: 4 }, { position: 7 }]);
        } finally {
            database.close();
        }
    });
    it("adds Git tracking state to older project databases", () => {
        const database = new DatabaseSync(":memory:");
        try {
            initializeSessionDatabase(database);
            // Rebuild the version 7 shape: no Git tracking columns, and the superseded `branch`
            // column that managed worktrees never populated.
            for (const [table, columns] of [
                [
                    "projects",
                    [
                        "presence",
                        "worktree_support",
                        "worktree_support_reason",
                        "git_branch",
                        "git_head",
                        "git_upstream",
                        "git_ahead",
                        "git_behind",
                        "git_detached",
                    ],
                ],
                [
                    "project_workspaces",
                    [
                        "base_commit",
                        "presence",
                        "git_branch",
                        "git_head",
                        "git_upstream",
                        "git_ahead",
                        "git_behind",
                        "git_detached",
                    ],
                ],
            ] as const) {
                for (const column of columns) {
                    database.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
                }
            }
            database.exec("ALTER TABLE project_workspaces ADD COLUMN branch TEXT");
            database.exec("PRAGMA user_version = 9");

            initializeSessionDatabase(database);

            expect(columnInfo(database, "projects", "presence")).toMatchObject({
                dflt_value: "'present'",
                notnull: 1,
                type: "TEXT",
            });
            expect(columnInfo(database, "projects", "worktree_support")).toMatchObject({
                dflt_value: "'unknown'",
                notnull: 1,
            });
            expect(columnInfo(database, "project_workspaces", "base_commit")).toBeDefined();
            expect(columnInfo(database, "project_workspaces", "git_branch")).toBeDefined();
            expect(columnInfo(database, "project_workspaces", "branch")).toBeUndefined();
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
        } finally {
            database.close();
        }
    });
});

function columnInfo(
    database: DatabaseSync,
    table: string,
    column: string,
): Record<string, unknown> | undefined {
    return database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .find((row) => row.name === column);
}
