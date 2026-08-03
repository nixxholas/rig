import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
    CURRENT_SESSION_DATABASE_VERSION,
    migrateSessionDatabase,
} from "../../database/migrateSessionDatabase.js";
import { openSessionDatabase } from "../../database/openSessionDatabase.js";

const directories: string[] = [];

const SCOPE_SHARING_TABLES = [
    "scope_share_entries",
    "scope_share_grants",
    "scope_share_members",
    "scope_share_outbox",
    "scope_share_replica_entries",
    "scope_share_replicas",
    "scope_share_session_cursors",
    "scope_shares",
];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { force: true, recursive: true });
    }
});

describe("scope sharing migration", () => {
    it("adds the scope sharing tables to a database at the previous version", () => {
        const opened = openTestDatabase();
        try {
            migrateSessionDatabase(opened.database);
            // Rewind to the schema this feature was written against and replay forward.
            for (const table of SCOPE_SHARING_TABLES) {
                opened.database.run(sql.raw(`DROP TABLE "${table}"`));
            }
            opened.database.run(
                sql.raw(`PRAGMA user_version = ${String(CURRENT_SESSION_DATABASE_VERSION - 1)}`),
            );

            migrateSessionDatabase(opened.database);

            expect(opened.database.get(sql.raw("PRAGMA user_version"))).toEqual({
                user_version: CURRENT_SESSION_DATABASE_VERSION,
            });
            expect(
                opened.database
                    .all<{ name: string }>(
                        sql.raw(
                            `SELECT name FROM sqlite_master
                             WHERE type = 'table' AND name LIKE 'scope_share%' ORDER BY name`,
                        ),
                    )
                    .map((row) => row.name),
            ).toEqual(SCOPE_SHARING_TABLES);
        } finally {
            opened.client.close();
        }
    });

    it("indexes at most one live share per scope and lets a stopped one be replaced", () => {
        const opened = openTestDatabase();
        try {
            migrateSessionDatabase(opened.database);
            opened.database.run(
                sql.raw(`INSERT INTO projects (
                    id, path, storage_key, kind, name, name_key, name_source, order_key,
                    initialization_status, initialization_attempt, presence, worktree_support,
                    git_ahead, git_behind, git_detached, version, created_at_ms, updated_at_ms
                ) VALUES (
                    'project-1', '/p', 'p', 'regular', 'p', 'p', 'folder', 'a0',
                    'ready', 0, 'present', 'supported', 0, 0, 0, 1, 1, 1
                )`),
            );

            insertShare(opened.database, "share-1", "active");

            expect(() => insertShare(opened.database, "share-2", "active")).toThrow();
            // The index is partial, so a degraded share still holds the scope and a
            // stopped one lets go of it.
            expect(() => insertShare(opened.database, "share-3", "degraded")).toThrow();
            opened.database.run(
                sql.raw("UPDATE scope_shares SET state = 'stopped' WHERE share_id = 'share-1'"),
            );
            insertShare(opened.database, "share-4", "active");

            expect(
                opened.database.get<{ count: number }>(
                    sql.raw("SELECT COUNT(*) AS count FROM scope_shares"),
                ),
            ).toEqual({ count: 2 });
        } finally {
            opened.client.close();
        }
    });
});

function insertShare(
    database: ReturnType<typeof openSessionDatabase>["database"],
    shareId: string,
    state: string,
): void {
    database.run(
        sql.raw(`INSERT INTO scope_shares (
            share_id, scope_kind, scope_id, project_id, state, owner_peer_id,
            created_at_ms, updated_at_ms
        ) VALUES (
            '${shareId}', 'workspace', 'workspace-1', 'project-1', '${state}', 'peer-owner', 1, 1
        )`),
    );
}

function openTestDatabase() {
    const directory = mkdtempSync(join(tmpdir(), "scope-sharing-migration-"));
    directories.push(directory);
    return openSessionDatabase(join(directory, "sessions.db"));
}
