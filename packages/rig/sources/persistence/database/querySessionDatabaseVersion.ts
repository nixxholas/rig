import { sql } from "drizzle-orm";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { DatabaseScope } from "../Transaction.js";
import { inDatabase } from "./inDatabase.js";
import type { DrizzleSessionTx } from "./SessionDatabase.js";

export const sessionDatabaseVersionSchema = Type.Integer({ minimum: 0 });
export type SessionDatabaseVersion = Static<typeof sessionDatabaseVersionSchema>;

export async function querySessionDatabaseVersion(
    tx: DatabaseScope,
): Promise<SessionDatabaseVersion> {
    return await inDatabase(tx, querySessionDatabaseVersionInTx);
}

export async function querySessionDatabaseVersionInTx(
    tx: DrizzleSessionTx,
): Promise<SessionDatabaseVersion> {
    const version = (await tx.get<{ user_version: unknown }>(sql.raw("PRAGMA user_version")))
        ?.user_version;
    return Value.Decode(sessionDatabaseVersionSchema, version);
}
