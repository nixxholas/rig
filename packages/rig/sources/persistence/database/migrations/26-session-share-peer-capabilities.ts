import { sql } from "drizzle-orm";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";

const statements = [
    `CREATE TABLE session_share_capabilities (
        share_member_id TEXT NOT NULL REFERENCES session_share_members(share_member_id) ON DELETE CASCADE,
        capability TEXT NOT NULL CHECK (capability IN ('terminal_view')),
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        granted_at_ms INTEGER NOT NULL,
        revoked_at_ms INTEGER,
        PRIMARY KEY (share_member_id, capability, grant_epoch)
    )`,
    // The audit table deliberately carries no foreign key on share_member_id. An
    // audit row must outlive the member row it describes: revoking or stopping a
    // share deletes members, but the record of what a peer did while it held a
    // capability must survive that deletion, which is the whole point of an audit
    // log. The FK on share_id is enough to reclaim the log when the share itself
    // is deleted.
    `CREATE TABLE session_share_peer_actions (
        share_id TEXT NOT NULL REFERENCES session_shares(share_id) ON DELETE CASCADE,
        share_member_id TEXT NOT NULL,
        grant_epoch INTEGER NOT NULL CHECK (grant_epoch >= 1),
        seq INTEGER NOT NULL CHECK (seq >= 1),
        capability TEXT NOT NULL CHECK (capability IN ('terminal_view')),
        action TEXT NOT NULL,
        detail TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied')),
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (share_id, seq)
    )`,
    "CREATE INDEX session_share_capabilities_state ON session_share_capabilities(share_member_id, state)",
    "CREATE INDEX session_share_peer_actions_recent ON session_share_peer_actions(share_id, created_at_ms DESC)",
] as const;

export async function sessionSharePeerCapabilities(database: SessionDatabase): Promise<void> {
    for (const statement of statements) await database.run(sql.raw(statement));
}
