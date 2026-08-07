import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

const sharingTables = [
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

export function removeFriendsAndSharing(database: SessionDatabase): void {
    for (const table of sharingTables) {
        database.run(sql.raw(`DROP TABLE ${table}`));
    }

    database.run(
        sql.raw(`CREATE TABLE happy_cloud_enrollment_next (
            singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
            contract_version INTEGER NOT NULL,
            version INTEGER NOT NULL,
            enrollment_state TEXT NOT NULL,
            enrollment_changed_at_ms INTEGER NOT NULL,
            group_chats_consent TEXT NOT NULL,
            group_chats_changed_at_ms INTEGER NOT NULL,
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
    database.run(
        sql.raw(`INSERT INTO happy_cloud_enrollment_next (
            singleton_id,
            contract_version,
            version,
            enrollment_state,
            enrollment_changed_at_ms,
            group_chats_consent,
            group_chats_changed_at_ms,
            remote_control_consent,
            remote_control_changed_at_ms,
            session_blob_persistence_consent,
            session_blob_persistence_changed_at_ms,
            happy_profile_consent,
            happy_profile_changed_at_ms,
            profile_ciphertext,
            profile_version,
            profile_changed_at_ms,
            updated_at_ms
        )
        SELECT
            singleton_id,
            contract_version,
            version,
            enrollment_state,
            enrollment_changed_at_ms,
            group_chats_consent,
            group_chats_changed_at_ms,
            remote_control_consent,
            remote_control_changed_at_ms,
            session_blob_persistence_consent,
            session_blob_persistence_changed_at_ms,
            happy_profile_consent,
            happy_profile_changed_at_ms,
            profile_ciphertext,
            profile_version,
            profile_changed_at_ms,
            updated_at_ms
        FROM happy_cloud_enrollment`),
    );
    database.run(sql.raw("DROP TABLE happy_cloud_enrollment"));
    database.run(sql.raw("ALTER TABLE happy_cloud_enrollment_next RENAME TO happy_cloud_enrollment"));
}