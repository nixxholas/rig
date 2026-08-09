import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import type { DrizzleSessionTx as SessionDatabase } from "../SessionDatabase.js";
import { p2pInstanceIdSchema } from "../../../protocol/P2pIdentityProtocol.js";

/**
 * Every existing session belonged to the Rig that stored it before sessions
 * could be created for a remote owner. Attribute those rows during migration;
 * all new writes explicitly carry their immutable owner.
 */
export async function sessionOwner(
    database: SessionDatabase,
    localInstanceId: string,
): Promise<void> {
    if (!Value.Check(p2pInstanceIdSchema, localInstanceId)) {
        throw new Error("The local Rig identity used to migrate session ownership is invalid.");
    }
    const sessions = (
        await database.all<{ name: string }>(
            sql.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"),
        )
    )[0];
    if (sessions === undefined) return;
    const existingColumn = (
        await database.all<{ name: string }>(sql.raw("PRAGMA table_info(sessions)"))
    ).some((column) => column.name === "owner_instance_id");
    if (existingColumn) return;
    await database.run(
        sql.raw(
            `ALTER TABLE sessions ADD COLUMN owner_instance_id TEXT NOT NULL DEFAULT '${localInstanceId}'`,
        ),
    );
}
