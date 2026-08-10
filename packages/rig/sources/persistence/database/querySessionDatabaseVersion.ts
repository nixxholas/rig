import { sql } from "drizzle-orm";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "./inDatabase.js";

export const sessionDatabaseVersionSchema = Type.Integer({ minimum: 0 });
export type SessionDatabaseVersion = Static<typeof sessionDatabaseVersionSchema>;

export async function querySessionDatabaseVersion(ctx: Context): Promise<SessionDatabaseVersion> {
    return await inDatabase(ctx, "rig.sql.database.query_version", querySessionDatabaseVersionInTx);
}

export async function querySessionDatabaseVersionInTx(
    ctx: Context,
): Promise<SessionDatabaseVersion> {
    const tx = ctx.tx;
    const version = (await tx.get<{ user_version: unknown }>(sql.raw("PRAGMA user_version")))
        ?.user_version;
    return Value.Decode(sessionDatabaseVersionSchema, version);
}
