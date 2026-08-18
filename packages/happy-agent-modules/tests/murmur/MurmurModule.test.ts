import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import { agentDatabaseRows } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    MURMUR_STORE_TABLE,
    murmurMigrations,
    readMurmurBinding,
} from "../../sources/murmur/MurmurDatabase.js";
import { MurmurModule } from "../../sources/murmur/MurmurModule.js";
import { murmurSnapshotSchema } from "../../sources/murmur/MurmurTypes.js";
import { ProfileModule } from "../../sources/profile/ProfileModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { FakeMurmurClient, encodeIdentity, identityBytes } from "./fakeMurmurClient.js";

const LOCAL_INSTANCE_ID = "alocalinstance000000001";

/** Every Murmur key currently in the agent database, which is what a reset has to leave empty. */
async function storedKeys(test: { context: Context }): Promise<readonly string[]> {
    const rows = await agentDatabaseRows<{ key: string }>(
        test.context.db,
        sql`SELECT key FROM ${sql.raw(MURMUR_STORE_TABLE)} ORDER BY key`,
    );
    return rows.map((row) => row.key);
}

async function createFixture(name: string, enabled = true) {
    const profiles = new ProfileModule({ now: () => 1_000 });
    const test = moduleDatabase([...murmurMigrations, ...profiles.migrations], name);
    await test.ready;
    profiles.open(LOCAL_INSTANCE_ID);
    const profile = await profiles.create(test.context, {
        email: "steve@example.test",
        name: "Steve",
    });
    const clients: FakeMurmurClient[] = [];
    const module = new MurmurModule({
        enabled,
        now: () => 1_000,
        // Each open is a fresh identity, exactly as a client with no stored keys would be, and it
        // writes one key so the store it was handed can be seen to be the agent's own database.
        openClient: async (_ctx, store) => {
            const client = new FakeMurmurClient({ identity: identityBytes(clients.length + 1) });
            clients.push(client);
            await store.set(`murmur/session-states/${clients.length}`, client.identity);
            return client;
        },
        profile: profiles,
        rootContext: test.rootContext,
    });
    return { clients, module, profile, profiles, test };
}

describe("MurmurModule", () => {
    it("refuses every sharing operation while the configuration keeps it off", async () => {
        const fixture = await createFixture("murmur-module-disabled", false);
        const ctx = fixture.test.context;
        try {
            expect(fixture.module.enabled).toBe(false);
            await expect(fixture.module.open(ctx, fixture.profile.id)).resolves.toBeUndefined();
            expect(fixture.module.running).toBe(false);
            await expect(storedKeys(fixture.test)).resolves.toEqual([]);

            const identity = encodeIdentity(identityBytes(1));
            await expect(fixture.module.snapshot(ctx)).rejects.toThrow("Sharing is disabled.");
            await expect(fixture.module.bindProfile(ctx, fixture.profile.id)).rejects.toThrow(
                "Sharing is disabled.",
            );
            await expect(fixture.module.createInvitation(ctx)).rejects.toThrow(
                "Sharing is disabled.",
            );
            await expect(fixture.module.requestContact(ctx, identity)).rejects.toThrow(
                "Sharing is disabled.",
            );
            await expect(fixture.module.acceptContact(ctx, "request-1")).rejects.toThrow(
                "Sharing is disabled.",
            );
            await expect(fixture.module.rejectContact(ctx, "request-1")).rejects.toThrow(
                "Sharing is disabled.",
            );
            await expect(fixture.module.removeContact(ctx, identity)).rejects.toThrow(
                "Sharing is disabled.",
            );
            await expect(fixture.module.reset(ctx)).rejects.toThrow("Sharing is disabled.");
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("waits for someone to be named before it connects to anything", async () => {
        const fixture = await createFixture("murmur-module-unbound");
        const ctx = fixture.test.context;
        try {
            await fixture.module.open(ctx);
            expect(fixture.module.running).toBe(false);
            await expect(storedKeys(fixture.test)).resolves.toEqual([]);
            expect(fixture.clients).toEqual([]);
            await expect(fixture.module.snapshot(ctx)).rejects.toThrow(
                "Sharing has no profile yet.",
            );

            const snapshot = await fixture.module.bindProfile(ctx, fixture.profile.id);
            expect(Value.Check(murmurSnapshotSchema, snapshot)).toBe(true);
            expect(snapshot.profileId).toBe(fixture.profile.id);
            expect(snapshot.identity).toBe(encodeIdentity(identityBytes(1)));
            expect(fixture.module.running).toBe(true);
            expect(fixture.clients).toHaveLength(1);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("opens again as the same person after a restart", async () => {
        const fixture = await createFixture("murmur-module-restart");
        const ctx = fixture.test.context;
        try {
            await fixture.module.bindProfile(ctx, fixture.profile.id);
            await fixture.module.close(ctx);

            // The same database, and therefore the same store, so the identity the first module
            // bound is the one this one has to present again.
            const restarted = new MurmurModule({
                enabled: true,
                openClient: async () => new FakeMurmurClient({ identity: identityBytes(1) }),
                profile: fixture.profiles,
                rootContext: fixture.test.rootContext,
            });
            try {
                await restarted.open(ctx);
                expect(restarted.running).toBe(true);
                await expect(restarted.snapshot(ctx)).resolves.toMatchObject({
                    identity: encodeIdentity(identityBytes(1)),
                    profileId: fixture.profile.id,
                });
            } finally {
                await restarted.close(ctx);
            }
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("throws the identity away on reset and comes back as the same person", async () => {
        const fixture = await createFixture("murmur-module-reset");
        const ctx = fixture.test.context;
        try {
            await fixture.module.bindProfile(ctx, fixture.profile.id);
            await expect(storedKeys(fixture.test)).resolves.toEqual(["murmur/session-states/1"]);

            const snapshot = await fixture.module.reset(ctx);
            expect(Value.Check(murmurSnapshotSchema, snapshot)).toBe(true);
            expect(snapshot).toMatchObject({
                contacts: [],
                identity: encodeIdentity(identityBytes(2)),
                profileId: fixture.profile.id,
            });
            expect(fixture.clients[0]?.closed).toBe(true);
            expect(fixture.clients).toHaveLength(2);
            // The discarded identity's keys are gone, and only the new client's remain.
            await expect(storedKeys(fixture.test)).resolves.toEqual(["murmur/session-states/2"]);
            await expect(readMurmurBinding(ctx)).resolves.toMatchObject({
                murmurIdentity: encodeIdentity(identityBytes(2)),
                profileId: fixture.profile.id,
            });
            expect(fixture.module.running).toBe(true);
        } finally {
            await fixture.module.close(ctx);
            fixture.test.close();
        }
    });

    it("discards the stored identity when reset arrives before anything started", async () => {
        const fixture = await createFixture("murmur-module-reset-cold");
        const ctx = fixture.test.context;
        try {
            await fixture.module.bindProfile(ctx, fixture.profile.id);
            await fixture.module.close(ctx);
            await expect(storedKeys(fixture.test)).resolves.toEqual(["murmur/session-states/1"]);

            const cold = new MurmurModule({
                enabled: true,
                openClient: async (_coldCtx, store) => {
                    await store.set("murmur/session-states/cold", identityBytes(7));
                    return new FakeMurmurClient({ identity: identityBytes(7) });
                },
                profile: fixture.profiles,
                rootContext: fixture.test.rootContext,
            });
            try {
                await expect(cold.reset(ctx)).resolves.toMatchObject({
                    identity: encodeIdentity(identityBytes(7)),
                    profileId: fixture.profile.id,
                });
                await expect(storedKeys(fixture.test)).resolves.toEqual([
                    "murmur/session-states/cold",
                ]);
            } finally {
                await cold.close(ctx);
            }
        } finally {
            fixture.test.close();
        }
    });

    it("refuses to reset an installation that never named anyone", async () => {
        const fixture = await createFixture("murmur-module-reset-unbound");
        try {
            await expect(fixture.module.reset(fixture.test.context)).rejects.toThrow(
                "Sharing has no profile to reset.",
            );
        } finally {
            await fixture.module.close(fixture.test.context);
            fixture.test.close();
        }
    });

    it("closes once however often it is asked", async () => {
        const fixture = await createFixture("murmur-module-close");
        const ctx = fixture.test.context;
        try {
            await fixture.module.bindProfile(ctx, fixture.profile.id);
            await fixture.module.close(ctx);
            await fixture.module.close(ctx);

            expect(fixture.module.running).toBe(false);
            expect(fixture.clients[0]?.closed).toBe(true);
            // Closing is not a reset: what the identity knows survives for the next start.
            await expect(storedKeys(fixture.test)).resolves.toEqual(["murmur/session-states/1"]);
            await expect(fixture.module.snapshot(ctx)).rejects.toThrow("Sharing is closing.");
        } finally {
            fixture.test.close();
        }
    });
});
