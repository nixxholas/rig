import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

const statements = [
    // `scope_kind` is present from the start: a project share is the same machinery
    // over a wider subject set, so widening the scope later needs no second migration.
    `CREATE TABLE scope_shares (
        share_id TEXT NOT NULL PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'project')),
        scope_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('active', 'degraded', 'stopped')),
        owner_peer_id TEXT NOT NULL,
        next_share_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_share_sequence >= 1),
        published_scope_version INTEGER NOT NULL DEFAULT -1
            CHECK (published_scope_version >= -1),
        outbox_bytes INTEGER NOT NULL DEFAULT 0 CHECK (outbox_bytes >= 0),
        outbox_count INTEGER NOT NULL DEFAULT 0 CHECK (outbox_count >= 0),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        stopped_at_ms INTEGER
    )`,
    `CREATE TABLE scope_share_members (
        share_member_id TEXT NOT NULL PRIMARY KEY,
        share_id TEXT NOT NULL REFERENCES scope_shares(share_id) ON DELETE CASCADE,
        murmur_peer_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        current_grant_epoch INTEGER NOT NULL CHECK (current_grant_epoch >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'stopped')),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (share_id, murmur_peer_id),
        UNIQUE (share_member_id, current_grant_epoch)
    )`,
    `CREATE TABLE scope_share_grants (
        share_member_id TEXT NOT NULL REFERENCES scope_share_members(share_member_id) ON DELETE CASCADE,
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'stopped')),
        created_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER,
        PRIMARY KEY (share_member_id, grant_epoch)
    )`,
    // A session share tails one session and needs one cursor. A scope share tails
    // every session in the scope at once, so each gets its own cursor and they take
    // turns, which is what keeps one busy session from starving the rest.
    //
    // `rotation_seq` is a counter, not a clock: a pass moves every cursor it served
    // to the back of the queue, and two cursors served in the same millisecond still
    // have to take their turns in order.
    `CREATE TABLE scope_share_session_cursors (
        share_id TEXT NOT NULL REFERENCES scope_shares(share_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        rotation_seq INTEGER NOT NULL DEFAULT 0 CHECK (rotation_seq >= 0),
        published_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (published_event_seq >= 0),
        index_version INTEGER NOT NULL DEFAULT -1 CHECK (index_version >= -1),
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, session_id)
    )`,
    `CREATE TABLE scope_share_outbox (
        share_id TEXT NOT NULL REFERENCES scope_shares(share_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        share_event_id TEXT NOT NULL UNIQUE,
        subject_kind TEXT NOT NULL
            CHECK (subject_kind IN ('scope', 'session_index', 'session_event')),
        subject_id TEXT NOT NULL,
        source_event_seq INTEGER REFERENCES session_events(seq) ON DELETE SET NULL
            CHECK (source_event_seq IS NULL OR source_event_seq >= 0),
        canonical_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, sequence),
        UNIQUE (share_id, source_event_seq)
    )`,
    `CREATE TABLE scope_share_entries (
        share_id TEXT NOT NULL REFERENCES scope_shares(share_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        share_event_id TEXT NOT NULL,
        subject_kind TEXT NOT NULL
            CHECK (subject_kind IN ('scope', 'session_index', 'session_event')),
        subject_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, sequence)
    )`,
    `CREATE TABLE scope_share_replicas (
        share_id TEXT NOT NULL PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'project')),
        owner_peer_id TEXT NOT NULL,
        murmur_peer_id TEXT NOT NULL,
        share_member_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        applied_through_sequence INTEGER NOT NULL DEFAULT 0
            CHECK (applied_through_sequence >= 0),
        title TEXT NOT NULL,
        member_count INTEGER NOT NULL CHECK (member_count >= 0),
        state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
        ended_reason TEXT,
        ended_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
    )`,
    `CREATE TABLE scope_share_replica_entries (
        share_id TEXT NOT NULL REFERENCES scope_share_replicas(share_id) ON DELETE CASCADE,
        share_event_id TEXT NOT NULL,
        grant_member_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        subject_kind TEXT NOT NULL
            CHECK (subject_kind IN ('scope', 'session_index', 'session_event')),
        subject_id TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, share_event_id),
        UNIQUE (share_id, sequence)
    )`,
    // At most one live share per scope. A second share of the same workspace would
    // be a second MLS group over the same subject, so the two would diverge silently.
    "CREATE UNIQUE INDEX scope_shares_one_current_per_scope ON scope_shares(scope_kind, scope_id) WHERE state <> 'stopped'",
    "CREATE INDEX scope_shares_project ON scope_shares(project_id, state)",
    "CREATE INDEX scope_share_members_share_state ON scope_share_members(share_id, state)",
    "CREATE INDEX scope_share_grants_state ON scope_share_grants(share_member_id, state)",
    // Round-robin fairness reads the least recently tailed cursor first.
    "CREATE INDEX scope_share_session_cursors_rotation ON scope_share_session_cursors(share_id, rotation_seq, session_id)",
    "CREATE INDEX scope_share_outbox_subject ON scope_share_outbox(share_id, subject_kind, subject_id)",
    "CREATE INDEX scope_share_outbox_source_event ON scope_share_outbox(share_id, source_event_seq)",
    "CREATE INDEX scope_share_entries_subject ON scope_share_entries(share_id, subject_kind, subject_id, sequence)",
    "CREATE INDEX scope_share_replicas_member ON scope_share_replicas(share_member_id, grant_epoch)",
    "CREATE INDEX scope_share_replica_entries_session ON scope_share_replica_entries(share_id, subject_kind, subject_id, sequence)",
] as const;

export function scopeSharing(database: SessionDatabase): void {
    for (const statement of statements) database.run(sql.raw(statement));
}
