import { Value } from "@sinclair/typebox/value";

import { rigProfileSchema, type RigProfile } from "../../protocol/ProfileProtocol.js";
import type { TX } from "../Transaction.js";
import { rigProfiles } from "../database/schema.js";

export function rigProfileCreate(tx: TX, profile: RigProfile): void {
    if (!Value.Check(rigProfileSchema, profile)) {
        throw new Error("The Rig profile is invalid.");
    }
    tx.insert(rigProfiles)
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
}
