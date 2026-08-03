import { sql } from "drizzle-orm";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { TX } from "../Transaction.js";

export const sessionDatabaseVersionSchema = Type.Integer({ minimum: 0 });
export type SessionDatabaseVersion = Static<typeof sessionDatabaseVersionSchema>;

export function querySessionDatabaseVersion(tx: TX): SessionDatabaseVersion {
    const version = tx.get<{ user_version: unknown }>(sql.raw("PRAGMA user_version"))?.user_version;
    return Value.Decode(sessionDatabaseVersionSchema, version);
}
