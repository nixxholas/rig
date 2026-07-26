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
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
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
            expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 });
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
            database.exec("PRAGMA user_version = 10");

            expect(() => initializeSessionDatabase(database)).toThrow(
                "The session database uses schema version 10, but this Rig version supports up to 9.",
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
});
