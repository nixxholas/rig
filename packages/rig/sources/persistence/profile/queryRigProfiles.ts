import { asc, eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigProfileSchema, type RigProfile } from "../../protocol/ProfileProtocol.js";
import type { TX } from "../Transaction.js";
import { rigProfiles } from "../database/schema.js";

export function queryRigProfiles(tx: TX): readonly RigProfile[] {
    return tx.select().from(rigProfiles).orderBy(asc(rigProfiles.id)).all().map(readProfile);
}

export function queryRigProfile(tx: TX, profileId: string): RigProfile | undefined {
    const row = tx.select().from(rigProfiles).where(eq(rigProfiles.id, profileId)).get();
    return row === undefined ? undefined : readProfile(row);
}

function readProfile(row: typeof rigProfiles.$inferSelect): RigProfile {
    const photo: unknown = row.photoJson === null ? undefined : JSON.parse(row.photoJson);
    const profile: unknown = {
        createdAt: row.createdAtMs,
        email: row.email,
        id: row.id,
        name: row.name,
        parentInstanceId: row.parentInstanceId,
        ...(photo === undefined ? {} : { photo }),
        updatedAt: row.updatedAtMs,
        version: row.version,
    };
    if (!Value.Check(rigProfileSchema, profile)) {
        throw new Error("The saved Rig profile is invalid.");
    }
    return profile;
}
