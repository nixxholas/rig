import { agentDatabaseRows, agentDatabaseRun } from "@slopus/happy-agent-base";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
    MURMUR_BINDING_MIGRATION_KEY,
    MURMUR_STORE_MIGRATION_KEY,
    MURMUR_STORE_TABLE,
    bindMurmurProfile,
    discardMurmurIdentity,
    murmurMigrations,
    readMurmurBinding,
} from "../../sources/murmur/MurmurDatabase.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const IDENTITY = "A".repeat(43);
const REPLACEMENT_IDENTITY = "B".repeat(43);
const PROFILE = "alocalprofile00000000001";
const OTHER_PROFILE = "anotherprofile0000000001";

describe("murmur binding", () => {
    it("owns a stable migration and binds one identity to one person", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-create");
        await test.ready;
        try {
            expect(murmurMigrations.map(([key]) => key)).toEqual([
                MURMUR_BINDING_MIGRATION_KEY,
                MURMUR_STORE_MIGRATION_KEY,
            ]);
            await expect(readMurmurBinding(test.context)).resolves.toBeUndefined();

            await expect(
                bindMurmurProfile(test.context, PROFILE, IDENTITY, 1_000),
            ).resolves.toBe("created");
            await expect(readMurmurBinding(test.context)).resolves.toEqual({
                createdAt: 1_000,
                murmurIdentity: IDENTITY,
                profileId: PROFILE,
            });

            await expect(
                bindMurmurProfile(test.context, PROFILE, IDENTITY, 2_000),
            ).resolves.toBe("unchanged");
            await expect(readMurmurBinding(test.context)).resolves.toMatchObject({
                createdAt: 1_000,
            });
        } finally {
            test.close();
        }
    });

    it("refuses another person and refuses another identity for the bound person", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-refusals");
        await test.ready;
        try {
            await bindMurmurProfile(test.context, PROFILE, IDENTITY, 1_000);

            await expect(
                bindMurmurProfile(test.context, OTHER_PROFILE, IDENTITY, 2_000),
            ).rejects.toThrow("This Murmur identity is already bound to another profile.");
            await expect(
                bindMurmurProfile(test.context, PROFILE, REPLACEMENT_IDENTITY, 2_000),
            ).rejects.toThrow("The stored Murmur identity does not match this sharing profile.");
            await expect(readMurmurBinding(test.context)).resolves.toEqual({
                createdAt: 1_000,
                murmurIdentity: IDENTITY,
                profileId: PROFILE,
            });
        } finally {
            test.close();
        }
    });

    it("keeps the person when the identity is forgotten and adopts the next one", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-clear");
        await test.ready;
        try {
            await bindMurmurProfile(test.context, PROFILE, IDENTITY, 1_000);
            await agentDatabaseRun(
                test.context.db,
                sql`INSERT INTO ${sql.raw(MURMUR_STORE_TABLE)} (key, value_base64)
                    VALUES ('murmur/session-states/1', 'AQID')`,
            );

            await discardMurmurIdentity(test.context);
            // The keys and the record of who they belonged to go together.
            await expect(
                agentDatabaseRows<{ key: string }>(
                    test.context.db,
                    sql`SELECT key FROM ${sql.raw(MURMUR_STORE_TABLE)}`,
                ),
            ).resolves.toEqual([]);
            await expect(readMurmurBinding(test.context)).resolves.toEqual({
                createdAt: 1_000,
                murmurIdentity: null,
                profileId: PROFILE,
            });

            await expect(
                bindMurmurProfile(test.context, PROFILE, REPLACEMENT_IDENTITY, 3_000),
            ).resolves.toBe("unchanged");
            await expect(readMurmurBinding(test.context)).resolves.toEqual({
                createdAt: 1_000,
                murmurIdentity: REPLACEMENT_IDENTITY,
                profileId: PROFILE,
            });
        } finally {
            test.close();
        }
    });

    it("forgets nothing when sharing was never bound", async () => {
        const test = moduleDatabase(murmurMigrations, "murmur-binding-clear-empty");
        await test.ready;
        try {
            await expect(discardMurmurIdentity(test.context)).resolves.toBeUndefined();
            await expect(readMurmurBinding(test.context)).resolves.toBeUndefined();
        } finally {
            test.close();
        }
    });
});
