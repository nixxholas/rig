import { eq } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";

import { rigProfileSchema, type RigProfile } from "../../protocol/ProfileProtocol.js";
import type { TX } from "../Transaction.js";
import { rigProfiles } from "../database/schema.js";

export function rigProfileUpdate(tx: TX, profile: RigProfile): void {
    if (!Value.Check(rigProfileSchema, profile)) {
        throw new Error("The Rig profile is invalid.");
    }
    const result = tx
        .update(rigProfiles)
        .set({
            email: profile.email,
            name: profile.name,
            photoJson: profile.photo === undefined ? null : JSON.stringify(profile.photo),
            updatedAtMs: profile.updatedAt,
            version: profile.version,
        })
        .where(eq(rigProfiles.id, profile.id))
        .run();
    if (result.changes !== 1) throw new Error("The Rig profile does not exist.");
}
