import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/**
 * One Murmur MLS group per shared folder root.
 *
 * Application snapshots and deliveries remain in Rig's main database. Murmur's separate store is
 * reserved for cryptographic/session state.
 */
export async function folderSharing(database: SessionDatabase): Promise<void> {
    const folderColumns = (
        await database.all<{ name: string }>(sql.raw("PRAGMA table_info(folders)"))
    ).map((column) => column.name);
    if (!folderColumns.includes("shared_group_id")) {
        await database.run(sql.raw("ALTER TABLE folders ADD COLUMN shared_group_id TEXT"));
    }
    await database.run(
        sql.raw(
            "CREATE UNIQUE INDEX IF NOT EXISTS folders_shared_group ON folders(shared_group_id) WHERE shared_group_id IS NOT NULL",
        ),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS folder_shares (
                group_id TEXT NOT NULL PRIMARY KEY,
                share_id TEXT NOT NULL UNIQUE,
                root_folder_id TEXT NOT NULL UNIQUE REFERENCES folders(id),
                state_json TEXT NOT NULL,
                logical_clock INTEGER NOT NULL DEFAULT 0 CHECK (logical_clock >= 0),
                status TEXT NOT NULL CHECK (status IN ('syncing', 'synced', 'error')),
                error TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                last_synced_at_ms INTEGER
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS folder_share_intents (
                share_id TEXT NOT NULL PRIMARY KEY,
                root_folder_id TEXT NOT NULL UNIQUE REFERENCES folders(id),
                state_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS folder_share_nodes (
                group_id TEXT NOT NULL REFERENCES folder_shares(group_id) ON DELETE CASCADE,
                folder_id TEXT NOT NULL,
                node_json TEXT,
                logical_clock INTEGER NOT NULL CHECK (logical_clock >= 0),
                sender TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY (group_id, folder_id)
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS folder_share_updates (
                delivery_id TEXT NOT NULL PRIMARY KEY,
                group_id TEXT NOT NULL REFERENCES folder_shares(group_id) ON DELETE CASCADE,
                operation_id TEXT NOT NULL,
                sender TEXT NOT NULL,
                logical_clock INTEGER NOT NULL CHECK (logical_clock >= 1),
                created_at_ms INTEGER NOT NULL,
                UNIQUE (group_id, operation_id)
            )
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TABLE IF NOT EXISTS folder_share_outbox (
                operation_id TEXT NOT NULL PRIMARY KEY,
                group_id TEXT NOT NULL REFERENCES folder_shares(group_id) ON DELETE CASCADE,
                payload_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            )
        `),
    );
    await database.run(
        sql.raw(
            "CREATE INDEX IF NOT EXISTS folder_share_outbox_pending ON folder_share_outbox(created_at_ms, operation_id)",
        ),
    );

    await database.run(
        sql.raw(`
            CREATE TRIGGER IF NOT EXISTS folders_shared_root_insert
            BEFORE INSERT ON folders
            WHEN NEW.shared_group_id IS NOT NULL AND NEW.parent_id IS NOT NULL
            BEGIN
                SELECT RAISE(ABORT, 'A shared folder must stay at the root.');
            END
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TRIGGER IF NOT EXISTS folders_shared_root_update
            BEFORE UPDATE OF parent_id, shared_group_id ON folders
            WHEN NEW.shared_group_id IS NOT NULL AND NEW.parent_id IS NOT NULL
            BEGIN
                SELECT RAISE(ABORT, 'A shared folder must stay at the root.');
            END
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TRIGGER IF NOT EXISTS folders_shared_subtree_contents_update
            BEFORE UPDATE OF parent_id ON folders
            WHEN NEW.parent_id IS NOT NULL
              AND EXISTS (
                WITH RECURSIVE ancestors(id, parent_id, shared_group_id) AS (
                    SELECT id, parent_id, shared_group_id
                    FROM folders
                    WHERE id = NEW.parent_id
                    UNION ALL
                    SELECT parent.id, parent.parent_id, parent.shared_group_id
                    FROM folders parent
                    JOIN ancestors child ON child.parent_id = parent.id
                )
                SELECT 1 FROM ancestors WHERE shared_group_id IS NOT NULL
              )
              AND EXISTS (
                WITH RECURSIVE subtree(id) AS (
                    SELECT NEW.id
                    UNION ALL
                    SELECT child.id
                    FROM folders child
                    JOIN subtree parent ON child.parent_id = parent.id
                    WHERE child.archived_at_ms IS NULL
                )
                SELECT 1
                FROM subtree
                WHERE EXISTS (
                    SELECT 1 FROM folder_items
                    WHERE folder_items.folder_id = subtree.id
                      AND folder_items.archived_at_ms IS NULL
                ) OR EXISTS (
                    SELECT 1 FROM sessions
                    WHERE sessions.folder_id = subtree.id
                      AND sessions.scope_kind = 'folder'
                      AND sessions.archived = 0
                )
              )
            BEGIN
                SELECT RAISE(ABORT, 'A shared folder can contain only folders.');
            END
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TRIGGER IF NOT EXISTS folder_items_shared_root_insert
            BEFORE INSERT ON folder_items
            WHEN EXISTS (
                WITH RECURSIVE ancestors(id, parent_id, shared_group_id) AS (
                    SELECT id, parent_id, shared_group_id
                    FROM folders
                    WHERE id = NEW.folder_id
                    UNION ALL
                    SELECT parent.id, parent.parent_id, parent.shared_group_id
                    FROM folders parent
                    JOIN ancestors child ON child.parent_id = parent.id
                )
                SELECT 1 FROM ancestors WHERE shared_group_id IS NOT NULL
            )
            BEGIN
                SELECT RAISE(ABORT, 'A shared folder can contain only folders.');
            END
        `),
    );
    await database.run(
        sql.raw(`
            CREATE TRIGGER IF NOT EXISTS folder_items_shared_root_update
            BEFORE UPDATE OF folder_id ON folder_items
            WHEN EXISTS (
                WITH RECURSIVE ancestors(id, parent_id, shared_group_id) AS (
                    SELECT id, parent_id, shared_group_id
                    FROM folders
                    WHERE id = NEW.folder_id
                    UNION ALL
                    SELECT parent.id, parent.parent_id, parent.shared_group_id
                    FROM folders parent
                    JOIN ancestors child ON child.parent_id = parent.id
                )
                SELECT 1 FROM ancestors WHERE shared_group_id IS NOT NULL
            )
            BEGIN
                SELECT RAISE(ABORT, 'A shared folder can contain only folders.');
            END
        `),
    );
    const sessions = await database.get<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (sessions !== undefined) {
        await database.run(
            sql.raw(`
            CREATE TRIGGER IF NOT EXISTS sessions_shared_root_insert
            BEFORE INSERT ON sessions
            WHEN NEW.scope_kind = 'folder' AND EXISTS (
                WITH RECURSIVE ancestors(id, parent_id, shared_group_id) AS (
                    SELECT id, parent_id, shared_group_id
                    FROM folders
                    WHERE id = NEW.folder_id
                    UNION ALL
                    SELECT parent.id, parent.parent_id, parent.shared_group_id
                    FROM folders parent
                    JOIN ancestors child ON child.parent_id = parent.id
                )
                SELECT 1 FROM ancestors WHERE shared_group_id IS NOT NULL
            )
            BEGIN
                SELECT RAISE(ABORT, 'A shared folder can contain only folders.');
            END
            `),
        );
        await database.run(
            sql.raw(`
            CREATE TRIGGER IF NOT EXISTS sessions_shared_root_update
            BEFORE UPDATE OF scope_kind, folder_id ON sessions
            WHEN NEW.scope_kind = 'folder' AND EXISTS (
                WITH RECURSIVE ancestors(id, parent_id, shared_group_id) AS (
                    SELECT id, parent_id, shared_group_id
                    FROM folders
                    WHERE id = NEW.folder_id
                    UNION ALL
                    SELECT parent.id, parent.parent_id, parent.shared_group_id
                    FROM folders parent
                    JOIN ancestors child ON child.parent_id = parent.id
                )
                SELECT 1 FROM ancestors WHERE shared_group_id IS NOT NULL
            )
            BEGIN
                SELECT RAISE(ABORT, 'A shared folder can contain only folders.');
            END
            `),
        );
    }
}
