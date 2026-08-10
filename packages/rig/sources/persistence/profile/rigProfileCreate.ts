import type { Context } from "@steve.kite/stdlib";

import { inDatabase } from "../database/inDatabase.js";
import { Value } from "@sinclair/typebox/value";

import { rigProfileSchema, type RigProfile } from "../../protocol/ProfileProtocol.js";
import { rigProfiles } from "../database/schema.js";

export async function rigProfileCreate(ctx: Context, profile: RigProfile): Promise<void> {
    return await inDatabase(ctx, "rig.sql.profile.rigProfileCreate", async (ctx) => {
        const tx = ctx.tx;
        if (!Value.Check(rigProfileSchema, profile)) {
            throw new Error("The Rig profile is invalid.");
        }
        await tx
            .insert(rigProfiles)
            .values({
                createdAtMs: profile.createdAt,
                email: profile.email,
                id: profile.id,
                name: profile.name,
                parentInstanceId: profile.parentInstanceId,
                photoJson: profile.photo === undefined ? null : JSON.stringify(profile.photo),
                updatedAtMs: profile.updatedAt,
                version: profile.version,
            })
            .run();
    });
}
