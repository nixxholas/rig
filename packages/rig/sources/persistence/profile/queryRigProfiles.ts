import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigProfileSchema, type RigProfile } from "../../protocol/ProfileProtocol.js";
import type { DatabaseScope } from "../Transaction.js";
import { rigProfiles } from "../database/schema.js";

export async function queryRigProfiles(tx: DatabaseScope): Promise<readonly RigProfile[]> {
    return await inDatabase(tx, async (tx) => {
        return (await tx.select().from(rigProfiles).orderBy(asc(rigProfiles.id)).all()).map(
            readProfile,
        );
    });
}

export async function queryRigProfile(
    tx: DatabaseScope,
    profileId: string,
): Promise<RigProfile | undefined> {
    return await inDatabase(tx, async (tx) => {
        const row = await tx.select().from(rigProfiles).where(eq(rigProfiles.id, profileId)).get();
        return row === undefined ? undefined : readProfile(row);
    });
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
