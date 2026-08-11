import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
    RIG_DATA_IDENTITY_MIGRATION_INDEX,
    RIG_DATA_IDENTITY_SCHEMA_VERSION,
} from "../migrateSessionDatabase.js";
import { agentTreeUsage } from "../migrations/08-agent-tree-usage.js";
import { projectComputeGeneration } from "../migrations/12-project-compute-generation.js";
import { projectUserMutationVersion } from "../migrations/16-project-user-mutation-version.js";
import { openSessionDatabase } from "../openSessionDatabase.js";
import { createTestRootContext } from "../../../testing/createTestRootContext.js";
import {
    dropSchemaAddedAfterIdentityMigrations,
    dropFolderItemsAndDocumentsSchema,
    dropSessionScopeSchema,
} from "./dropSchemaAddedAfterIdentityMigrations.js";
import * as schema from "../schema.js";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("migrateSessionDatabase", () => {
    it("creates the complete schema from the init migration", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);

        expect(await opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });
        expect(
            (
                await opened.database.all<{ name: string }>(
                    sql.raw(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                    ),
                )
            ).map((row) => row.name),
        ).toEqual(
            Object.values(schema)
                .map((table) => getTableConfig(table).name)
                .sort(),
        );
        expect(
            await opened.database.get<{ workspaceQueueWaiting: number }>(
                sql.raw(
                    "SELECT workspace_queue_waiting AS workspaceQueueWaiting FROM sessions LIMIT 1",
                ),
            ),
        ).toBeUndefined();
        expect(
            (
                await opened.database.all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
            ).map((column) => column.name),
        ).toContain("workspace_queue_waiting");

        await opened.database.close(opened.ctx);
    });

    it("keeps an initialized database unchanged on later starts", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);
        await migrateSessionDatabase(opened.ctx);

        expect(await opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });

        await opened.database.close(opened.ctx);
    });

    it("marks only demonstrably queued pre-v53 Happy history as backfilled", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);
        await opened.database.run(sql.raw("PRAGMA foreign_keys = OFF"));
        await opened.database.run(
            sql.raw("ALTER TABLE happy_sessions DROP COLUMN history_backfilled"),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO happy_sessions (
                    session_id,
                    credential_fingerprint,
                    tag,
                    remote_session_id,
                    encryption_variant,
                    encryption_key_base64,
                    last_remote_seq,
                    created_at_ms,
                    updated_at_ms
                ) VALUES
                    ('crash-window', 'account', 'rig:crash-window', NULL, 'dataKey', 'key', 0, 1, 1),
                    ('queued', 'account', 'rig:queued', NULL, 'dataKey', 'key', 0, 1, 1),
                    ('remote', 'account', 'rig:remote', 'remote-session', 'dataKey', 'key', 0, 1, 1)
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO happy_outbox (
                    session_id,
                    local_id,
                    payload_json,
                    created_at_ms
                ) VALUES ('queued', 'queued-message', '{}', 1)
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO session_events (
                    session_id,
                    event_id,
                    type,
                    data_json,
                    created_at_ms
                ) VALUES
                    ('crash-window', 'event-crash', 'session_updated', '{}', 1),
                    ('queued', 'event-queued', 'session_updated', '{}', 2),
                    ('remote', 'event-remote', 'session_updated', '{}', 3)
            `),
        );
        await opened.database.run(sql.raw("PRAGMA user_version = 52"));

        await migrateSessionDatabase(opened.ctx);

        expect(
            await opened.database.all<{ history_backfilled: number; session_id: string }>(
                sql.raw(`
                    SELECT session_id, history_backfilled
                    FROM happy_sessions
                    ORDER BY session_id
                `),
            ),
        ).toEqual([
            { history_backfilled: 0, session_id: "crash-window" },
            { history_backfilled: 1, session_id: "queued" },
            { history_backfilled: 1, session_id: "remote" },
        ]);
        expect(
            await opened.database.all<{
                projected_event_id: string | null;
                session_id: string;
            }>(
                sql.raw(`
                    SELECT session_id, projected_event_id
                    FROM happy_sessions
                    ORDER BY session_id
                `),
            ),
        ).toEqual([
            { projected_event_id: null, session_id: "crash-window" },
            { projected_event_id: "event-queued", session_id: "queued" },
            { projected_event_id: "event-remote", session_id: "remote" },
        ]);
        await opened.database.close(opened.ctx);
    });

    it("baselines acknowledged Happy history when upgrading directly from version 53", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);
        await opened.database.run(sql.raw("PRAGMA foreign_keys = OFF"));
        await opened.database.run(
            sql.raw(`
                INSERT INTO happy_sessions (
                    session_id,
                    credential_fingerprint,
                    tag,
                    encryption_variant,
                    encryption_key_base64,
                    last_remote_seq,
                    created_at_ms,
                    updated_at_ms,
                    history_backfilled
                ) VALUES ('session-53', 'account', 'rig:session-53', 'dataKey', 'key', 0, 1, 1, 1)
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO session_events (
                    session_id,
                    event_id,
                    type,
                    data_json,
                    created_at_ms
                ) VALUES ('session-53', 'event-53', 'session_updated', '{}', 1)
            `),
        );
        await opened.database.run(sql.raw("PRAGMA user_version = 53"));

        await migrateSessionDatabase(opened.ctx);

        expect(
            await opened.database.get<{
                projected_event_id: string | null;
                projection_status: string;
            }>(
                sql.raw(`
                    SELECT projected_event_id, projection_status
                    FROM happy_sessions
                    WHERE session_id = 'session-53'
                `),
            ),
        ).toEqual({ projected_event_id: "event-53", projection_status: "active" });
        await opened.database.close(opened.ctx);
    });

    it("does not advance a valid v52 database that lost the Happy session table", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);
        await opened.database.run(sql.raw("PRAGMA foreign_keys = OFF"));
        await opened.database.run(sql.raw("DROP TABLE happy_sessions"));
        await opened.database.run(sql.raw("PRAGMA user_version = 52"));

        await expect(migrateSessionDatabase(opened.ctx)).rejects.toThrow(
            "Cannot migrate Happy history because happy_sessions is missing.",
        );
        expect(await opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: 52,
        });

        await opened.database.close(opened.ctx);
    });

    it("normalizes folder and item keys into one space per parent", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);
        await opened.client.execute("PRAGMA foreign_keys = OFF");
        await opened.database.run(
            sql.raw(`
                INSERT INTO folders
                    (id, parent_id, name, order_key, path, version, created_at_ms, updated_at_ms)
                VALUES
                    ('root-folder', NULL, 'Root', 'a0', '/root', 1, 1, 1),
                    ('parent-folder', 'root-folder', 'Parent', 'a0', '/parent', 1, 1, 1),
                    ('child-a', 'parent-folder', 'Child A', 'a0', '/child-a', 1, 1, 1),
                    ('child-b', 'parent-folder', 'Child B', 'a1', '/child-b', 1, 1, 1)
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO folder_items
                    (id, folder_id, project_id, order_key, version, created_at_ms, updated_at_ms)
                VALUES
                    ('item-a', 'parent-folder', 'missing-project-a', 'a0', 1, 1, 1),
                    ('item-b', 'parent-folder', 'missing-project-b', 'a1', 1, 1, 1)
            `),
        );

        await opened.database.run(sql.raw("PRAGMA user_version = 50"));
        await migrateSessionDatabase(opened.ctx);

        const folders = await opened.database.all<{ id: string; order_key: string }>(
            sql.raw(
                "SELECT id, order_key FROM folders WHERE parent_id = 'parent-folder' ORDER BY order_key",
            ),
        );
        const items = await opened.database.all<{ id: string; order_key: string }>(
            sql.raw(
                "SELECT id, order_key FROM folder_items WHERE folder_id = 'parent-folder' ORDER BY order_key",
            ),
        );
        expect(folders.map((row) => row.id)).toEqual(["child-a", "child-b"]);
        expect(items.map((row) => row.id)).toEqual(["item-a", "item-b"]);
        expect(new Set([...folders, ...items].map((row) => row.order_key)).size).toBe(4);
        expect(folders.at(-1)!.order_key < items[0]!.order_key).toBe(true);

        await opened.database.close(opened.ctx);
    });

    it("rejects legacy folder and item ID collisions before enabling shared anchors", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);
        await opened.client.execute("PRAGMA foreign_keys = OFF");
        await opened.database.run(
            sql.raw(`
                INSERT INTO folders
                    (id, parent_id, name, order_key, path, version, created_at_ms, updated_at_ms)
                VALUES
                    ('collision', NULL, 'Collision', 'a0', '/collision', 1, 1, 1),
                    ('parent-for-item', NULL, 'Parent', 'a1', '/parent-for-item', 1, 1, 1)
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO folder_items
                    (id, folder_id, project_id, order_key, version, created_at_ms, updated_at_ms)
                VALUES ('collision', 'parent-for-item', 'missing-project', 'a0', 1, 1, 1)
            `),
        );
        await opened.database.run(sql.raw("PRAGMA user_version = 50"));

        await expect(migrateSessionDatabase(opened.ctx)).rejects.toThrow(
            "Cannot enable shared folder ordering because a folder and folder item have the same ID.",
        );
        expect(await opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: 50,
        });
        expect(
            await opened.database.get<{ order_key: string }>(
                sql.raw("SELECT order_key FROM folder_items WHERE id = 'collision'"),
            ),
        ).toEqual({ order_key: "a0" });

        await opened.database.close(opened.ctx);
    });

    it("seeds one singleton onboarding state row", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);

        expect(await opened.database.select().from(schema.onboardingState).all()).toEqual([
            {
                completedVersion: 0,
                singleton: 1,
            },
        ]);
        await expect(
            opened.database.update(schema.onboardingState).set({ completedVersion: -1 }).run(),
        ).rejects.toThrow(/CHECK constraint failed|Failed query/u);

        await opened.database.close(opened.ctx);
    });

    it("attributes pre-owner sessions to the local Rig while advancing to session owner schema", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);
        await opened.database.run(sql.raw("ALTER TABLE sessions DROP COLUMN owner_instance_id"));
        await opened.database.run(sql.raw("DROP TABLE sharing_settings"));
        await opened.database.run(sql.raw("DROP TABLE sharing_profile_binding"));
        await dropFolderItemsAndDocumentsSchema(opened.database);
        await opened.database.run(sql.raw("PRAGMA user_version = 38"));

        await migrateSessionDatabase(opened.ctx, {
            localInstanceId: "alocalinstance00000000001",
        });

        expect(
            (
                await opened.database.all<{ dflt_value: string | null; name: string }>(
                    sql.raw("PRAGMA table_info(sessions)"),
                )
            ).find((column) => column.name === "owner_instance_id"),
        ).toMatchObject({ dflt_value: "'alocalinstance00000000001'" });
        await opened.database.close(opened.ctx);
    });

    it("removes sharing data without removing trusted P2P peers", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);

        await opened.database.run(
            sql.raw(`INSERT INTO p2p_peers (
                instance_id,
                public_key,
                name,
                bindings_json,
                connections_json,
                created_at_ms,
                updated_at_ms
            ) VALUES ('peer-1', 'public-key-1', 'Remote Rig', '[]', '[]', 1, 1)`),
        );
        await opened.database.run(
            sql.raw(`INSERT INTO p2p_peer_pairings (
                pairing_id,
                instance_id,
                public_key,
                name,
                bindings_json,
                connections_json,
                assign_primary,
                state,
                expires_at_ms
            ) VALUES ('pairing-1', 'peer-1', 'public-key-1', 'Remote Rig', '[]', '[]', 0, 'prepared', 2)`),
        );
        for (const table of removedSharingTables) {
            await opened.database.run(sql.raw(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`));
        }
        await opened.database.run(
            sql.raw(
                "ALTER TABLE happy_cloud_enrollment ADD COLUMN friends_consent TEXT NOT NULL DEFAULT 'denied'",
            ),
        );
        await opened.database.run(
            sql.raw(
                "ALTER TABLE happy_cloud_enrollment ADD COLUMN friends_changed_at_ms INTEGER NOT NULL DEFAULT 0",
            ),
        );
        await opened.database.run(sql.raw("ALTER TABLE project_workspaces ADD COLUMN title TEXT"));
        await opened.database.run(
            sql.raw("ALTER TABLE project_workspaces DROP COLUMN name_configured"),
        );
        await opened.database.run(sql.raw("ALTER TABLE project_workspaces DROP COLUMN branch"));
        await dropSessionScopeSchema(opened.database);
        await opened.database.run(sql.raw("DROP INDEX IF EXISTS sessions_unsorted"));
        await opened.database.run(sql.raw("ALTER TABLE sessions DROP COLUMN unsorted_since_ms"));
        await opened.database.run(sql.raw("DROP INDEX IF EXISTS sessions_folder"));
        await opened.database.run(sql.raw("ALTER TABLE sessions DROP COLUMN folder_id"));
        await opened.database.run(sql.raw("DROP TABLE folders"));
        // A real database at version 28 predates worklets, so rewinding to it takes their schema
        // with it rather than letting its later migration replay into tables it already created.
        await opened.database.run(sql.raw("DROP TABLE worklet_versions"));
        await opened.database.run(sql.raw("DROP TABLE worklets"));
        await opened.database.run(sql.raw("DROP TABLE sharing_settings"));
        await opened.database.run(sql.raw("DROP TABLE sharing_profile_binding"));
        await opened.database.run(sql.raw("DROP TABLE rig_profiles"));
        await opened.database.run(sql.raw("DROP TABLE session_mutations"));
        await opened.database.run(sql.raw("DROP TABLE folder_mutations"));
        await opened.database.run(sql.raw("DROP TABLE folder_catalog"));
        await dropFolderItemsAndDocumentsSchema(opened.database);
        await opened.database.run(sql.raw("PRAGMA user_version = 28"));

        await migrateSessionDatabase(opened.ctx);

        expect(
            await opened.database.all<{ name: string }>(
                sql.raw(
                    `SELECT name FROM sqlite_master
                     WHERE type = 'table' AND name IN (${removedSharingTables.map((table) => `'${table}'`).join(", ")})`,
                ),
            ),
        ).toEqual([]);
        expect(
            await opened.database.get(
                sql.raw("SELECT instance_id, name FROM p2p_peers WHERE instance_id = 'peer-1'"),
            ),
        ).toEqual({ instance_id: "peer-1", name: "Remote Rig" });
        expect(
            await opened.database.get(
                sql.raw(
                    "SELECT pairing_id, instance_id FROM p2p_peer_pairings WHERE pairing_id = 'pairing-1'",
                ),
            ),
        ).toEqual({ instance_id: "peer-1", pairing_id: "pairing-1" });
        expect(
            (
                await opened.database.all<{ name: string }>(
                    sql.raw("PRAGMA table_info(happy_cloud_enrollment)"),
                )
            ).map((column) => column.name),
        ).not.toContain("friends_consent");
        expect(
            (
                await opened.database.all<{ name: string }>(
                    sql.raw("PRAGMA table_info(happy_cloud_enrollment)"),
                )
            ).map((column) => column.name),
        ).not.toContain("friends_changed_at_ms");
        expect(
            (
                await opened.database.all<{ name: string }>(
                    sql.raw("PRAGMA table_info(happy_cloud_enrollment)"),
                )
            ).map((column) => column.name),
        ).not.toContain("live_session_sharing_consent");
        expect(
            (
                await opened.database.all<{ name: string }>(
                    sql.raw("PRAGMA table_info(happy_cloud_enrollment)"),
                )
            ).map((column) => column.name),
        ).not.toContain("live_session_sharing_changed_at_ms");

        await opened.database.close(opened.ctx);
    });

    it("does not replay the identity migration when the following migration runs", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "stable-epoch" });
        await dropSchemaAddedAfterIdentityMigrations(opened.database);
        await opened.database.run(
            sql.raw("ALTER TABLE rig_data_identity DROP COLUMN format_version"),
        );
        await opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(RIG_DATA_IDENTITY_SCHEMA_VERSION)}`),
        );

        await migrateSessionDatabase(opened.ctx, {
            createDataEpoch: () => {
                throw new Error("The identity migration was replayed.");
            },
        });

        expect(
            await opened.database.get(
                sql.raw("SELECT epoch, format_version FROM rig_data_identity"),
            ),
        ).toEqual({ epoch: "stable-epoch", format_version: 1 });
        expect(await opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });
        await opened.database.close(opened.ctx);
    });

    it("pins the data identity migration at index 19", async () => {
        expect(RIG_DATA_IDENTITY_MIGRATION_INDEX).toBe(19);
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "discarded" });
        await dropSchemaAddedAfterIdentityMigrations(opened.database);
        await opened.database.run(sql.raw("DROP TABLE rig_data_identity"));
        await opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(RIG_DATA_IDENTITY_MIGRATION_INDEX)}`),
        );

        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "pinned-epoch" });

        expect(
            await opened.database.get(
                sql.raw("SELECT epoch, format_version FROM rig_data_identity"),
            ),
        ).toEqual({ epoch: "pinned-epoch", format_version: 1 });
        await opened.database.close(opened.ctx);
    });

    it("creates and enforces the named identity constraints", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx, { createDataEpoch: () => "checked-epoch" });
        const tableSql = (
            await opened.database.get<{ sql: string }>(
                sql.raw("SELECT sql FROM sqlite_master WHERE name = 'rig_data_identity'"),
            )
        )?.sql;

        expect(tableSql).toContain("CONSTRAINT rig_data_identity_singleton");
        expect(tableSql).toContain("CONSTRAINT rig_data_identity_format_version");
        await expect(
            opened.database.run(sql.raw("UPDATE rig_data_identity SET format_version = 2")),
        ).rejects.toThrow();
        await expect(
            opened.database.run(
                sql.raw(
                    "INSERT INTO rig_data_identity (singleton, epoch, format_version) VALUES (2, 'other', 1)",
                ),
            ),
        ).rejects.toThrow();
        expect(
            await opened.database.get(
                sql.raw("SELECT singleton, format_version FROM rig_data_identity"),
            ),
        ).toEqual({ format_version: 1, singleton: 1 });
        await opened.database.close(opened.ctx);
    });

    it("discards only pre-icon applets while preserving legacy slot entries", async () => {
        const opened = await openTestDatabase();
        await opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        await opened.database.run(sql.raw("PRAGMA user_version = 9"));
        await opened.database.run(sql.raw("CREATE TABLE unrelated_data (value TEXT NOT NULL)"));
        await opened.database.run(sql.raw("INSERT INTO unrelated_data (value) VALUES ('keep me')"));
        await opened.database.run(
            sql.raw(
                "CREATE TABLE projects (id TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1)",
            ),
        );
        // This partial version-9 fixture skips init, so keep the Happy tables that a real
        // version-9 database already owns while isolating the applet migration behavior.
        await opened.database.run(
            sql.raw(`
                CREATE TABLE happy_sessions (
                    session_id TEXT NOT NULL PRIMARY KEY,
                    credential_fingerprint TEXT NOT NULL,
                    tag TEXT NOT NULL,
                    remote_session_id TEXT,
                    encryption_variant TEXT NOT NULL,
                    encryption_key_base64 TEXT NOT NULL,
                    last_remote_seq INTEGER NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                CREATE TABLE happy_outbox (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    local_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    UNIQUE (session_id, local_id)
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                CREATE TABLE project_workspaces (
                    id TEXT NOT NULL PRIMARY KEY,
                    storage_key TEXT NOT NULL,
                    title TEXT
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                CREATE TABLE slot_entries (
                    id TEXT NOT NULL PRIMARY KEY,
                    slot TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    project_id TEXT,
                    workspace_id TEXT,
                    session_id TEXT,
                    content_json TEXT NOT NULL,
                    author_session_id TEXT NOT NULL,
                    description TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO slot_entries (
                    id,
                    slot,
                    scope,
                    content_json,
                    author_session_id,
                    description,
                    purpose,
                    created_at_ms,
                    updated_at_ms
                ) VALUES (
                    'legacy-slot',
                    'status-line',
                    'everywhere',
                    '{"type":"text","markdown":"Legacy status"}',
                    'session-1',
                    'Legacy status',
                    'Preserve the old slot entry',
                    1,
                    2
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                CREATE TABLE webapps (
                    name TEXT NOT NULL PRIMARY KEY,
                    description TEXT NOT NULL,
                    purpose TEXT NOT NULL,
                    author_session_id TEXT NOT NULL,
                    source_description TEXT,
                    current_version INTEGER NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                CREATE TABLE webapp_versions (
                    webapp_name TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    change_description TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    PRIMARY KEY (webapp_name, version)
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO webapps (
                    name,
                    description,
                    purpose,
                    author_session_id,
                    current_version,
                    created_at_ms,
                    updated_at_ms
                ) VALUES ('old-dashboard', 'Old', 'Old', 'session-1', 1, 1, 1)
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO webapp_versions (
                    webapp_name,
                    version,
                    change_description,
                    created_at_ms
                ) VALUES ('old-dashboard', 1, 'Initial import', 1)
            `),
        );

        await migrateSessionDatabase(opened.ctx);

        expect(await opened.database.all(sql.raw("SELECT * FROM applets"))).toEqual([]);
        expect(await opened.database.all(sql.raw("SELECT * FROM applet_versions"))).toEqual([]);
        expect(
            await opened.database.get(
                sql.raw(`
                    SELECT author_type, author_id, author_name
                    FROM slot_entries
                    WHERE id = 'legacy-slot'
                `),
            ),
        ).toEqual({
            author_type: "agent",
            author_id: "session-1",
            author_name: null,
        });
        expect(await opened.database.get(sql.raw("SELECT value FROM unrelated_data"))).toEqual({
            value: "keep me",
        });
        expect(
            (
                await opened.database.all<{ name: string }>(sql.raw("PRAGMA table_info(applets)"))
            ).map((column) => column.name),
        ).toContain("icon_thumbhash");
        expect(
            (
                await opened.database.all<{ name: string }>(
                    sql.raw("PRAGMA table_info(applet_versions)"),
                )
            ).map((column) => column.name),
        ).toContain("applet_name");

        await opened.database.close(opened.ctx);
    });

    it("atomically replaces a database from the previous migration generation", async () => {
        const opened = await openTestDatabase();
        await opened.database.run(sql.raw("CREATE TABLE legacy_data (value TEXT NOT NULL)"));
        await opened.database.run(sql.raw("INSERT INTO legacy_data (value) VALUES ('discard me')"));
        await opened.database.run(sql.raw("PRAGMA user_version = 13"));

        await migrateSessionDatabase(opened.ctx);

        expect(
            await opened.database.get(
                sql.raw("SELECT name FROM sqlite_master WHERE name = 'legacy_data'"),
            ),
        ).toBeUndefined();
        expect(await opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: CURRENT_SESSION_DATABASE_VERSION,
        });

        await opened.database.close(opened.ctx);
    });

    it("keeps the init migration atomic", async () => {
        const opened = await openTestDatabase();
        await opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        await opened.database.run(
            sql.raw("CREATE TABLE project_avatar_assets (hash TEXT PRIMARY KEY)"),
        );

        await expect(migrateSessionDatabase(opened.ctx)).rejects.toThrow();
        expect(await opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
            user_version: 0,
        });
        expect(
            (
                await opened.database.all<{ name: string }>(
                    sql.raw(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                    ),
                )
            ).map((row) => row.name),
        ).toEqual(["project_avatar_assets"]);

        await opened.database.close(opened.ctx);
    });

    it("rejects a database created by an unknown future schema", async () => {
        const opened = await openTestDatabase();
        await opened.database.run(sql.raw("PRAGMA application_id = 1380534066"));
        await opened.database.run(
            sql.raw(`PRAGMA user_version = ${String(CURRENT_SESSION_DATABASE_VERSION + 1)}`),
        );

        await expect(migrateSessionDatabase(opened.ctx)).rejects.toThrow(
            new RegExp(`supports up to ${String(CURRENT_SESSION_DATABASE_VERSION)}`, "u"),
        );

        await opened.database.close(opened.ctx);
    });

    it("keeps the Drizzle schema identical to the applied migrations", async () => {
        const opened = await openTestDatabase();
        await migrateSessionDatabase(opened.ctx);

        for (const table of Object.values(schema)) {
            const config = getTableConfig(table);
            const actualColumns = await opened.database.all<{
                name: string;
                notnull: number;
                pk: number;
            }>(sql.raw(`PRAGMA table_info(${config.name})`));
            expect(actualColumns.map((column) => column.name)).toEqual(
                config.columns.map((column) => column.name),
            );
            for (const column of config.columns) {
                const actual = actualColumns.find((candidate) => candidate.name === column.name);
                expect(actual, `${config.name}.${column.name}`).toBeDefined();
                if (column.notNull) {
                    expect(
                        actual!.notnull === 1 ||
                            (actual!.pk > 0 && column.getSQLType() === "integer"),
                        `${config.name}.${column.name} must be NOT NULL`,
                    ).toBe(true);
                }
            }
        }

        await opened.database.close(opened.ctx);
    });

    it("starts existing project compute settings at generation one", async () => {
        const opened = await openTestDatabase();
        await opened.database.run(
            sql.raw(`
                CREATE TABLE projects (
                    id TEXT NOT NULL PRIMARY KEY,
                    default_compute TEXT,
                    default_docker_image TEXT
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO projects (id, default_compute, default_docker_image)
                VALUES
                    ('docker', 'docker', 'rig-dev:latest'),
                    ('local', 'local', NULL),
                    ('unset', NULL, NULL)
            `),
        );

        await projectComputeGeneration(opened.database);

        expect(
            await opened.database.all<{ default_compute_generation: number; id: string }>(
                sql.raw("SELECT id, default_compute_generation FROM projects ORDER BY id"),
            ),
        ).toEqual([
            { default_compute_generation: 1, id: "docker" },
            { default_compute_generation: 1, id: "local" },
            { default_compute_generation: 0, id: "unset" },
        ]);
        await opened.database.close(opened.ctx);
    });

    it("starts existing project user mutation versions at their current versions", async () => {
        const opened = await openTestDatabase();
        await opened.database.run(
            sql.raw(`
                CREATE TABLE projects (
                    id TEXT NOT NULL PRIMARY KEY,
                    version INTEGER NOT NULL
                )
            `),
        );
        await opened.database.run(
            sql.raw(`
                INSERT INTO projects (id, version)
                VALUES ('first', 4), ('second', 9)
            `),
        );

        await projectUserMutationVersion(opened.database);

        expect(
            await opened.database.all<{
                id: string;
                user_mutation_version: number;
            }>(sql.raw("SELECT id, user_mutation_version FROM projects ORDER BY id")),
        ).toEqual([
            { id: "first", user_mutation_version: 4 },
            { id: "second", user_mutation_version: 9 },
        ]);
        await opened.database.close(opened.ctx);
    });

    it("backfills exact committed lifetime usage and adds the delegated traversal index", async () => {
        const opened = await openTestDatabase();
        await opened.database.run(
            sql.raw(`
            CREATE TABLE sessions (
                id TEXT NOT NULL PRIMARY KEY,
                delegated_by_session_id TEXT,
                created_at_ms INTEGER NOT NULL,
                usage_json TEXT
            )
        `),
        );
        await opened.database.run(
            sql.raw(`
            INSERT INTO sessions (id, delegated_by_session_id, created_at_ms, usage_json)
            VALUES
                (
                    'exact',
                    'root',
                    1,
                    '{"committed":{"totalTokens":125},"summary":{"groups":[{"usage":{"totalTokens":100}},{"usage":{"totalTokens":25}}]}}'
                ),
                ('negative', 'root', 2, '{"committed":{"totalTokens":-5}}'),
                ('invalid', 'root', 3, '{invalid'),
                ('missing', NULL, 4, NULL)
        `),
        );

        await agentTreeUsage(opened.database);

        expect(
            await opened.database.all<{ id: string; lifetime_total_tokens: number }>(
                sql.raw(
                    "SELECT id, lifetime_total_tokens FROM sessions ORDER BY created_at_ms, id",
                ),
            ),
        ).toEqual([
            { id: "exact", lifetime_total_tokens: 125 },
            { id: "negative", lifetime_total_tokens: 0 },
            { id: "invalid", lifetime_total_tokens: 0 },
            { id: "missing", lifetime_total_tokens: 0 },
        ]);
        expect(
            (
                await opened.database.all<{ detail: string }>(
                    sql.raw(`
                        EXPLAIN QUERY PLAN
                        SELECT id
                        FROM sessions INDEXED BY sessions_delegated_created
                        WHERE delegated_by_session_id = 'root'
                        ORDER BY created_at_ms, id
                    `),
                )
            ).some((row) => row.detail.includes("sessions_delegated_created")),
        ).toBe(true);

        await opened.database.close(opened.ctx);
    });
});

const removedSharingTables = [
    "session_share_peer_actions",
    "session_share_capabilities",
    "session_share_entries",
    "session_share_replica_entries",
    "session_share_replicas",
    "session_share_message_context",
    "session_share_friend_messages",
    "session_share_outbox",
    "session_share_grants",
    "session_share_snapshot_messages",
    "session_share_members",
    "session_shares",
    "scope_share_replica_entries",
    "scope_share_replicas",
    "scope_share_entries",
    "scope_share_outbox",
    "scope_share_session_cursors",
    "scope_share_grants",
    "scope_share_members",
    "scope_shares",
] as const;

async function openTestDatabase() {
    const directory = mkdtempSync(join(tmpdir(), "rig-database-init-"));
    directories.push(directory);
    return await openSessionDatabase(createTestRootContext(), join(directory, "sessions.sqlite"));
}
