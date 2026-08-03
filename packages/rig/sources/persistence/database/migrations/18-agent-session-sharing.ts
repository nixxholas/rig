import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

const statements = [
    `CREATE TABLE session_shares (
        share_id TEXT NOT NULL PRIMARY KEY,
        owner_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('active', 'degraded', 'stopped')),
        include_friend_messages INTEGER NOT NULL,
        owner_peer_id TEXT NOT NULL,
        snapshot_through_position INTEGER CHECK (snapshot_through_position IS NULL OR snapshot_through_position >= 0),
        snapshot_through_event_id TEXT,
        published_message_position INTEGER NOT NULL DEFAULT -1
            CHECK (published_message_position >= -1),
        published_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (published_event_seq >= 0),
        next_share_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_share_sequence >= 1),
        outbox_bytes INTEGER NOT NULL DEFAULT 0 CHECK (outbox_bytes >= 0),
        outbox_count INTEGER NOT NULL DEFAULT 0 CHECK (outbox_count >= 0),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        stopped_at_ms INTEGER
    )`,
    `CREATE TABLE session_share_members (
        share_member_id TEXT NOT NULL PRIMARY KEY,
        share_id TEXT NOT NULL REFERENCES session_shares(share_id) ON DELETE CASCADE,
        murmur_peer_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        current_grant_epoch INTEGER NOT NULL CHECK (current_grant_epoch >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'stopped')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (share_id, murmur_peer_id),
        UNIQUE (share_member_id, current_grant_epoch)
    )`,
    `CREATE TABLE session_share_grants (
        share_member_id TEXT NOT NULL REFERENCES session_share_members(share_member_id) ON DELETE CASCADE,
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'stopped')),
        created_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        PRIMARY KEY (share_member_id, grant_epoch)
    )`,
    `CREATE TABLE session_share_outbox (
        share_id TEXT NOT NULL REFERENCES session_shares(share_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        share_event_id TEXT NOT NULL UNIQUE,
        source_event_seq INTEGER REFERENCES session_events(seq) ON DELETE SET NULL
            CHECK (source_event_seq IS NULL OR source_event_seq >= 0),
        canonical_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, sequence),
        UNIQUE (share_id, source_event_seq)
    )`,
    `CREATE TABLE session_share_friend_messages (
        share_id TEXT NOT NULL REFERENCES session_shares(share_id) ON DELETE CASCADE,
        share_member_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        client_message_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        owner_session_id TEXT NOT NULL,
        owner_position INTEGER NOT NULL CHECK (owner_position >= 0),
        created_at_ms INTEGER NOT NULL,
        UNIQUE (share_id, share_member_id, grant_epoch, client_message_id),
        FOREIGN KEY (share_member_id, grant_epoch)
            REFERENCES session_share_grants(share_member_id, grant_epoch) ON DELETE CASCADE,
        FOREIGN KEY (owner_session_id, owner_position)
            REFERENCES session_messages(session_id, position) ON DELETE CASCADE
    )`,
    `CREATE TABLE session_share_message_context (
        message_id TEXT NOT NULL PRIMARY KEY
            REFERENCES session_share_friend_messages(message_id) ON DELETE CASCADE,
        share_id TEXT NOT NULL REFERENCES session_shares(share_id) ON DELETE CASCADE,
        share_member_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('pending', 'included', 'overflow')),
        included_run_id TEXT,
        byte_estimate INTEGER NOT NULL CHECK (byte_estimate >= 0),
        token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (share_member_id, grant_epoch)
            REFERENCES session_share_grants(share_member_id, grant_epoch) ON DELETE CASCADE
    )`,
    `CREATE TABLE session_share_replicas (
        share_id TEXT NOT NULL PRIMARY KEY,
        owner_peer_id TEXT NOT NULL,
        murmur_peer_id TEXT NOT NULL,
        share_member_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        title TEXT NOT NULL,
        member_count INTEGER NOT NULL CHECK (member_count >= 0),
        state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
        ended_reason TEXT,
        ended_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )`,
    `CREATE TABLE session_share_replica_entries (
        share_id TEXT NOT NULL REFERENCES session_share_replicas(share_id) ON DELETE CASCADE,
        share_event_id TEXT NOT NULL,
        grant_member_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        canonical_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, share_event_id),
        UNIQUE (share_id, sequence)
    )`,
    "CREATE INDEX session_share_members_share_state ON session_share_members(share_id, state)",
    "CREATE UNIQUE INDEX session_shares_one_current_per_owner ON session_shares(owner_session_id) WHERE state <> 'stopped'",
    "CREATE INDEX session_share_grants_state ON session_share_grants(share_member_id, state)",
    "CREATE INDEX session_share_outbox_source_event ON session_share_outbox(share_id, source_event_seq)",
    "CREATE INDEX session_share_friend_messages_owner ON session_share_friend_messages(owner_session_id, owner_position)",
    "CREATE INDEX session_share_message_context_disposition ON session_share_message_context(share_id, disposition, updated_at_ms)",
    "CREATE INDEX session_share_replicas_member ON session_share_replicas(share_member_id, grant_epoch)",
] as const;

export function agentSessionSharing(database: SessionDatabase): void {
    for (const statement of statements) database.run(sql.raw(statement));
}
