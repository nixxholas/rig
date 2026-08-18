import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROFILE_MIGRATION_KEY, ProfileModule } from "../../sources/profile/ProfileModule.js";
import {
    profileChangedEventSchema,
    profileSchema,
    type ProfileChangedEvent,
} from "../../sources/profile/ProfileTypes.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

const LOCAL_INSTANCE_ID = "alocalinstance000000001";
const OTHER_INSTANCE_ID = "anotherinstance00000001";

/**
 * The module reads the wall clock, so the test moves the wall clock. Nothing about the moment a
 * profile was written is injectable any more, which is what the production code relies on.
 */
async function createFixture(name: string) {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: ProfileChangedEvent[] = [];
    const profiles = new ProfileModule();
    const unsubscribe = profiles.onEvent((_ctx, event) => {
        events.push(event);
    });
    const test = moduleDatabase(profiles.migrations, name);
    await test.ready;
    profiles.open(LOCAL_INSTANCE_ID);
    return { events, profiles, test, unsubscribe };
}

describe("ProfileModule", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

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

            vi.setSystemTime(2_000);
            const updated = await fixture.profiles.update(ctx, profile.id, { name: "Steve K" });
            expect(updated).toEqual({
                ...profile,
                name: "Steve K",
                updatedAt: 2_000,
                version: 2,
            });
            await expect(fixture.profiles.get(ctx)).resolves.toEqual(updated);

            vi.setSystemTime(3_000);
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

            const elsewhere = new ProfileModule();
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

            const unopened = new ProfileModule();
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
            vi.setSystemTime(2_000);
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

    it("stops telling a listener that has walked away, and keeps the others", async () => {
        const fixture = await createFixture("profile-unsubscribe");
        const ctx = fixture.test.context;
        try {
            const second: string[] = [];
            const stopSecond = fixture.profiles.onEvent((_ctx, event) => {
                second.push(event.id);
            });

            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            expect(fixture.events).toHaveLength(1);
            expect(second).toEqual([`${profile.id}-1`]);

            fixture.unsubscribe();
            fixture.unsubscribe();
            await fixture.profiles.update(ctx, profile.id, { name: "Steve K" });

            expect(fixture.events).toHaveLength(1);
            expect(second).toEqual([`${profile.id}-1`, `${profile.id}-2`]);

            stopSecond();
            await fixture.profiles.update(ctx, profile.id, { name: "Steve Korshakov" });
            expect(second).toHaveLength(2);
        } finally {
            fixture.test.close();
        }
    });

    it("saves the change even when a listener throws afterwards", async () => {
        const fixture = await createFixture("profile-listener-failure");
        const ctx = fixture.test.context;
        try {
            fixture.profiles.onEvent(() => {
                throw new Error("listener exploded");
            });

            const profile = await fixture.profiles.create(ctx, {
                email: "steve@example.test",
                name: "Steve",
            });
            await expect(fixture.profiles.get(ctx)).resolves.toEqual(profile);
            expect(fixture.events).toHaveLength(1);
        } finally {
            fixture.test.close();
        }
    });

    it("refuses anything but a function as a listener", async () => {
        const fixture = await createFixture("profile-listener-shape");
        try {
            for (const candidate of [undefined, null, 42, "listener", {}]) {
                expect(() => fixture.profiles.onEvent(candidate as never)).toThrow(
                    "Profile event listener must be a function.",
                );
            }
        } finally {
            fixture.test.close();
        }
    });
});
