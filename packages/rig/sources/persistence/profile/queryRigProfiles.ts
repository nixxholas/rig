import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { asc, eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigProfileSchema, type RigProfile } from "../../protocol/ProfileProtocol.js";
import { rigProfiles } from "../database/schema.js";

export async function queryRigProfiles(ctx: Context): Promise<readonly RigProfile[]> {
    return await inDatabase(ctx, "rig.sql.profile.queryRigProfiles", async (ctx) => {
        const tx = ctx.tx;
        return (await tx.select().from(rigProfiles).orderBy(asc(rigProfiles.id)).all()).map(
            readProfile,
        );
    });
}

export async function queryRigProfile(
    ctx: Context,
    profileId: string,
): Promise<RigProfile | undefined> {
    return await inDatabase(ctx, "rig.sql.profile.queryRigProfile", async (ctx) => {
        const tx = ctx.tx;
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
