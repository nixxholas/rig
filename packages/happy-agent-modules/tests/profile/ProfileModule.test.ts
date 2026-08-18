import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { PROFILE_MIGRATION_KEY, ProfileModule } from "../../sources/profile/ProfileModule.js";
import {
    profileChangedEventSchema,
    profileSchema,
    type ProfileChangedEvent,
} from "../../sources/profile/ProfileTypes.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const LOCAL_INSTANCE_ID = "alocalinstance000000001";
const OTHER_INSTANCE_ID = "anotherinstance00000001";

async function createFixture(name: string) {
    const events: ProfileChangedEvent[] = [];
    const clock = { now: 1_000 };
    const profiles = new ProfileModule({
        now: () => clock.now,
        listener: {
            onEvent: (_ctx, event) => {
                events.push(event);
            },
        },
    });
    const test = moduleDatabase(profiles.migrations, name);
    await test.ready;
    profiles.open(LOCAL_INSTANCE_ID);
    return { clock, events, profiles, test };
}

describe("ProfileModule", () => {
    it("names the one person behind this installation and refuses a second", async () => {
        const fixture = await createFixture("profile-create");
        const ctx = fixture.test.context;
        try {
            expect(fixture.profiles.migrations.map(([key]) => key)).toEqual([
                PROFILE_MIGRATION_KEY,
            ]);
            await expect(fixture.profiles.get(ctx)).resolves.toBeUndefined();

            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            expect(Value.Check(profileSchema, profile)).toBe(true);
            expect(profile).toMatchObject({
                createdAt: 1_000,
                email: "steve@example.test",
                name: "Steve",
                parentInstanceId: LOCAL_INSTANCE_ID,
                updatedAt: 1_000,
                version: 1,
            });
            await expect(fixture.profiles.get(ctx)).resolves.toEqual(profile);
            await expect(fixture.profiles.getById(ctx, profile.id)).resolves.toEqual(profile);
            await expect(fixture.profiles.getById(ctx, "amissingprofile00000001")).resolves
                .toBeUndefined();
            await expect(fixture.profiles.isLocal(ctx, profile.id)).resolves.toBe(true);

            await expect(
                fixture.profiles.create(ctx, { email: "other@example.test", name: "Other" }),
            ).rejects.toThrow("This installation already has a profile.");
            await expect(fixture.profiles.get(ctx)).resolves.toEqual(profile);
        } finally {
            fixture.test.close();
        }
    });

    it("counts every change and moves the moment it was changed", async () => {
        const fixture = await createFixture("profile-update");
        const ctx = fixture.test.context;
        try {
            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });

            fixture.clock.now = 2_000;
            const updated = await fixture.profiles.update(ctx, profile.id, { name: "Steve K" });
            expect(updated).toEqual({
                ...profile,
                name: "Steve K",
                updatedAt: 2_000,
                version: 2,
            });
            await expect(fixture.profiles.get(ctx)).resolves.toEqual(updated);

            fixture.clock.now = 3_000;
            await expect(
                fixture.profiles.update(ctx, profile.id, { email: "steve@elsewhere.test" }),
            ).resolves.toMatchObject({
                email: "steve@elsewhere.test",
                name: "Steve K",
                updatedAt: 3_000,
                version: 3,
            });
        } finally {
            fixture.test.close();
        }
    });

    it("has nothing to update when the id belongs to nobody here", async () => {
        const fixture = await createFixture("profile-update-unknown");
        const ctx = fixture.test.context;
        try {
            await fixture.profiles.create(ctx, { email: "steve@example.test", name: "Steve" });
            await expect(
                fixture.profiles.update(ctx, "amissingprofile00000001", { name: "Nobody" }),
            ).resolves.toBeUndefined();
            expect(fixture.events).toHaveLength(1);
        } finally {
            fixture.test.close();
        }
    });

    it("lets only the installation that owns a person speak for them", async () => {
        const fixture = await createFixture("profile-ownership");
        const ctx = fixture.test.context;
        try {
            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });

            const elsewhere = new ProfileModule({ now: () => 4_000 });
            elsewhere.open(OTHER_INSTANCE_ID);
            await expect(elsewhere.isLocal(ctx, profile.id)).resolves.toBe(false);
            await expect(elsewhere.update(ctx, profile.id, { name: "Stolen" })).rejects.toThrow(
                "Only this profile's own installation may change it.",
            );
            await expect(fixture.profiles.get(ctx)).resolves.toEqual(profile);
        } finally {
            fixture.test.close();
        }
    });

    it("knows nothing is local until it learns which installation this is", async () => {
        const fixture = await createFixture("profile-not-open");
        const ctx = fixture.test.context;
        try {
            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });

            const unopened = new ProfileModule({});
            await expect(unopened.isLocal(ctx, profile.id)).resolves.toBe(false);
            await expect(unopened.get(ctx)).resolves.toEqual(profile);
            await expect(
                unopened.create(ctx, { email: "steve@example.test", name: "Steve" }),
            ).rejects.toThrow("The profile is not open yet.");
        } finally {
            fixture.test.close();
        }
    });

    it("refuses a name or an email address it would not be safe to show anyone", async () => {
        const fixture = await createFixture("profile-validation");
        const ctx = fixture.test.context;
        try {
            for (const name of ["", "Steve\u202eK", "Steve\u0007"]) {
                await expect(
                    fixture.profiles.create(ctx, { email: "steve@example.test", name }),
                ).rejects.toThrow("The profile name or email address is not valid.");
            }
            for (const email of ["steve", "steve@example", "steve <steve@example.test>"]) {
                await expect(
                    fixture.profiles.create(ctx, { email, name: "Steve" }),
                ).rejects.toThrow("The profile name or email address is not valid.");
            }
            await expect(fixture.profiles.get(ctx)).resolves.toBeUndefined();

            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            await expect(fixture.profiles.update(ctx, profile.id, {})).rejects.toThrow(
                "The profile name or email address is not valid.",
            );
            await expect(
                fixture.profiles.update(ctx, profile.id, { email: "steve@example" }),
            ).rejects.toThrow("The profile name or email address is not valid.");
        } finally {
            fixture.test.close();
        }
    });

    it("tells listeners which version of the person is current now", async () => {
        const fixture = await createFixture("profile-events");
        const ctx = fixture.test.context;
        try {
            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            fixture.clock.now = 2_000;
            await fixture.profiles.update(ctx, profile.id, { name: "Steve K" });

            expect(fixture.events.every((event) => Value.Check(profileChangedEventSchema, event)))
                .toBe(true);
            expect(fixture.events).toEqual([
                {
                    createdAt: 1_000,
                    data: { profileId: profile.id, version: 1 },
                    id: `${profile.id}-1`,
                    type: "profile_changed",
                },
                {
                    createdAt: 2_000,
                    data: { profileId: profile.id, version: 2 },
                    id: `${profile.id}-2`,
                    type: "profile_changed",
                },
            ]);
        } finally {
            fixture.test.close();
        }
    });
});
