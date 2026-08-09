import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

/** Ordered folder links plus opaque, CAS-written live documents. */
export async function folderItemsAndDocuments(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`
        CREATE TABLE documents (
            id TEXT NOT NULL PRIMARY KEY,
            mime_type TEXT NOT NULL,
            state_json TEXT NOT NULL,
            version INTEGER NOT NULL,
            first_retained_version INTEGER NOT NULL,
            created_by_instance_id TEXT NOT NULL,
            created_by_profile_id TEXT,
            unread_cursor TEXT,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )
    `),
    );
    await database.run(
        sql.raw(`
        CREATE TABLE document_updates (
            id TEXT NOT NULL PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES documents(id),
            version INTEGER NOT NULL,
            update_json TEXT NOT NULL,
            byte_length INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            UNIQUE (document_id, version)
        )
    `),
    );
    await database.run(
        sql.raw(
            "CREATE INDEX document_updates_document_version ON document_updates(document_id, version)",
        ),
    );
    await database.run(
        sql.raw(`
        CREATE TABLE document_mutations (
            mutation_id TEXT NOT NULL PRIMARY KEY,
            action TEXT NOT NULL,
            document_id TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            result_version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL
        )
    `),
    );
    await database.run(
        sql.raw(
            "CREATE INDEX document_mutations_created ON document_mutations(created_at_ms, mutation_id)",
        ),
    );
    await database.run(
        sql.raw(`
        CREATE TABLE folder_items (
            id TEXT NOT NULL PRIMARY KEY,
            folder_id TEXT NOT NULL REFERENCES folders(id),
            project_id TEXT REFERENCES projects(id),
            workspace_id TEXT REFERENCES project_workspaces(id),
            document_id TEXT REFERENCES documents(id),
            order_key TEXT NOT NULL,
            version INTEGER NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            archived_at_ms INTEGER,
            CONSTRAINT folder_items_exactly_one_target CHECK (
                (project_id IS NOT NULL) +
                (workspace_id IS NOT NULL) +
                (document_id IS NOT NULL) = 1
            )
        )
    `),
    );
    await database.run(
        sql.raw(
            "CREATE INDEX folder_items_folder_order ON folder_items(folder_id, archived_at_ms, order_key, id)",
        ),
    );
    await database.run(
        sql.raw(`
        CREATE TABLE folder_item_mutations (
            mutation_id TEXT NOT NULL PRIMARY KEY,
            action TEXT NOT NULL,
            item_id TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        )
    `),
    );
    await database.run(
        sql.raw(
            "CREATE INDEX folder_item_mutations_created ON folder_item_mutations(created_at_ms, mutation_id)",
        ),
    );
}
