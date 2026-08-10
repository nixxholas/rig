import { createTestRootContext } from "../testing/createTestRootContext.js";
import { afterEach, describe, expect, it } from "vitest";

import type { RigProfileChangedEvent } from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { RigProfileStore } from "./RigProfileStore.js";

const LOCAL_INSTANCE = "alocalparent00000000000001";
const REMOTE_INSTANCE = "aremoteparent0000000000001";
const ctx = createTestRootContext();

describe("RigProfileStore", () => {
    let database: PersistentSessionStore | undefined;

    afterEach(async () => {
        await database?.close(ctx);
    });

    it("creates and updates a parent-owned profile after committing it", async () => {
        database = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const events: RigProfileChangedEvent[] = [];
        let now = 1_000;
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            now: () => now,
            publish: (_ctx, event) => {
                events.push(event);
            },
        });

        const created = await profiles.create(ctx, {
            email: "steve@example.test",
            name: "Steve 🧑‍💻",
        });
        expect(created).toMatchObject({
            createdAt: 1_000,
            email: "steve@example.test",
            name: "Steve 🧑‍💻",
            parentInstanceId: LOCAL_INSTANCE,
            updatedAt: 1_000,
        });
        expect(await profiles.list(ctx)).toEqual([created]);
        expect(events).toEqual([
            expect.objectContaining({
                createdAt: 1_000,
                data: { profileId: created.id, version: 1 },
                id: expect.any(String),
                type: "profile_changed",
            }),
        ]);

        now = 2_000;
        const updated = await profiles.update(ctx, created.id, {
            email: "steve@happy.engineering",
            name: "Steve Korshakov",
            photo: {
                bytes: 3,
                data: "YWJj",
                height: 1,
                mediaType: "image/webp",
                thumbhash: "dGh1bWI=",
                width: 1,
            },
        });
        expect(updated).toMatchObject({
            createdAt: 1_000,
            email: "steve@happy.engineering",
            name: "Steve Korshakov",
            parentInstanceId: LOCAL_INSTANCE,
            updatedAt: 2_000,
        });
        expect(updated?.version).toBe(2);
        expect(await profiles.get(ctx, created.id)).toEqual(updated);
        expect(events).toHaveLength(2);
    });

    it("replicates only the authenticated parent's profile and keeps newer state", async () => {
        database = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            publish: () => undefined,
        });
        const profile = {
            createdAt: 1_000,
            email: "remote@example.test",
            id: "aprofile000000000000000001",
            name: "Remote person",
            parentInstanceId: REMOTE_INSTANCE,
            updatedAt: 2_000,
            version: 2,
        } as const;

        expect(await profiles.replicate(ctx, profile, REMOTE_INSTANCE)).toEqual(profile);
        expect(await profiles.owns(ctx, profile.id, REMOTE_INSTANCE)).toBe(true);
        expect(
            await profiles.replicate(ctx, { ...profile, name: "Old", version: 1 }, REMOTE_INSTANCE),
        ).toEqual(profile);
        await expect(
            profiles.replicate(ctx, profile, "aotherparent00000000000001"),
        ).rejects.toThrow("not owned by its authenticated parent");
        await expect(
            profiles.replicate(ctx, { ...profile, name: "Conflicting content" }, REMOTE_INSTANCE),
        ).rejects.toThrow("version was reused");
    });

    it("does not let the local Rig mutate a replicated profile", async () => {
        database = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            publish: () => undefined,
        });
        const profile = {
            createdAt: 1_000,
            email: "remote@example.test",
            id: "aprofile000000000000000002",
            name: "Remote person",
            parentInstanceId: REMOTE_INSTANCE,
            updatedAt: 1_000,
            version: 1,
        } as const;
        await profiles.replicate(ctx, profile, REMOTE_INSTANCE);

        await expect(profiles.update(ctx, profile.id, { name: "Claimed locally" })).rejects.toThrow(
            "Only a profile's parent Rig may change it.",
        );
    });
});
