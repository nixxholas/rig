import { afterEach, describe, expect, it } from "vitest";

import type { RigProfileChangedEvent } from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { RigProfileStore } from "./RigProfileStore.js";

const LOCAL_INSTANCE = "alocalparent00000000000001";
const REMOTE_INSTANCE = "aremoteparent0000000000001";

describe("RigProfileStore", () => {
    let database: PersistentSessionStore | undefined;

    afterEach(() => database?.close());

    it("creates and updates a parent-owned profile after committing it", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const events: RigProfileChangedEvent[] = [];
        let now = 1_000;
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            now: () => now,
            publish: (event) => events.push(event),
        });

        const created = profiles.create({ name: "Steve 🧑‍💻" });
        expect(created).toMatchObject({
            createdAt: 1_000,
            name: "Steve 🧑‍💻",
            parentInstanceId: LOCAL_INSTANCE,
            updatedAt: 1_000,
        });
        expect(profiles.list()).toEqual([created]);
        expect(events).toEqual([
            expect.objectContaining({
                createdAt: 1_000,
                data: { profileId: created.id, version: 1 },
                id: expect.any(String),
                type: "profile_changed",
            }),
        ]);

        now = 2_000;
        const updated = profiles.update(created.id, {
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
            name: "Steve Korshakov",
            parentInstanceId: LOCAL_INSTANCE,
            updatedAt: 2_000,
        });
        expect(updated?.version).toBe(2);
        expect(profiles.get(created.id)).toEqual(updated);
        expect(events).toHaveLength(2);
    });

    it("replicates only the authenticated parent's profile and keeps newer state", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            publish: () => undefined,
        });
        const profile = {
            createdAt: 1_000,
            id: "aprofile000000000000000001",
            name: "Remote person",
            parentInstanceId: REMOTE_INSTANCE,
            updatedAt: 2_000,
            version: 2,
        } as const;

        expect(profiles.replicate(profile, REMOTE_INSTANCE)).toEqual(profile);
        expect(profiles.owns(profile.id, REMOTE_INSTANCE)).toBe(true);
        expect(
            profiles.replicate({ ...profile, name: "Old", version: 1 }, REMOTE_INSTANCE),
        ).toEqual(profile);
        expect(() => profiles.replicate(profile, "aotherparent00000000000001")).toThrow(
            "not owned by its authenticated parent",
        );
        expect(() =>
            profiles.replicate({ ...profile, name: "Conflicting content" }, REMOTE_INSTANCE),
        ).toThrow("version was reused");
    });

    it("does not let the local Rig mutate a replicated profile", () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            publish: () => undefined,
        });
        const profile = {
            createdAt: 1_000,
            id: "aprofile000000000000000002",
            name: "Remote person",
            parentInstanceId: REMOTE_INSTANCE,
            updatedAt: 1_000,
            version: 1,
        } as const;
        profiles.replicate(profile, REMOTE_INSTANCE);

        expect(() => profiles.update(profile.id, { name: "Claimed locally" })).toThrow(
            "Only a profile's parent Rig may change it.",
        );
    });
});
