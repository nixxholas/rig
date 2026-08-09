import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

export async function happyCloudEnrollment(database: SessionDatabase): Promise<void> {
    await database.run(
        sql.raw(`CREATE TABLE happy_cloud_enrollment (
            singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
            contract_version INTEGER NOT NULL,
            version INTEGER NOT NULL,
            enrollment_state TEXT NOT NULL,
            enrollment_changed_at_ms INTEGER NOT NULL,
            friends_consent TEXT NOT NULL,
            friends_changed_at_ms INTEGER NOT NULL,
            group_chats_consent TEXT NOT NULL,
            group_chats_changed_at_ms INTEGER NOT NULL,
            live_session_sharing_consent TEXT NOT NULL,
            live_session_sharing_changed_at_ms INTEGER NOT NULL,
            remote_control_consent TEXT NOT NULL,
            remote_control_changed_at_ms INTEGER NOT NULL,
            session_blob_persistence_consent TEXT NOT NULL,
            session_blob_persistence_changed_at_ms INTEGER NOT NULL,
            happy_profile_consent TEXT NOT NULL,
            happy_profile_changed_at_ms INTEGER NOT NULL,
            profile_ciphertext TEXT,
            profile_version INTEGER,
            profile_changed_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )`),
    );
    await database.run(
        sql.raw(`CREATE TABLE happy_cloud_session_blobs (
            session_id TEXT NOT NULL PRIMARY KEY,
            ciphertext TEXT NOT NULL,
            version INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )`),
    );
    await database.run(
        sql.raw(`CREATE TABLE happy_cloud_mutation_receipts (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            mutation_id TEXT NOT NULL UNIQUE,
            request_fingerprint TEXT NOT NULL,
            response_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL
        )`),
    );
}
