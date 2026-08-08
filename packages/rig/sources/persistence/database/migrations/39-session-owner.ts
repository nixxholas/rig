import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import type { SessionDatabase } from "../openSessionDatabase.js";
import { p2pInstanceIdSchema } from "../../../protocol/P2pIdentityProtocol.js";

/**
 * Every existing session belonged to the Rig that stored it before sessions
 * could be created for a remote owner. Attribute those rows during migration;
 * all new writes explicitly carry their immutable owner.
 */
export function sessionOwner(database: SessionDatabase, localInstanceId: string): void {
    if (!Value.Check(p2pInstanceIdSchema, localInstanceId)) {
        throw new Error("The local Rig identity used to migrate session ownership is invalid.");
    }
    const sessions = database.get<{ name: string }>(
        sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
    );
    if (sessions === undefined) return;
    const existingColumn = database
        .all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
        .some((column) => column.name === "owner_instance_id");
    if (existingColumn) return;
    database.run(
        sql.raw(
            `ALTER TABLE sessions ADD COLUMN owner_instance_id TEXT NOT NULL DEFAULT '${localInstanceId}'`,
        ),
    );
}
