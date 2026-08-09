import { describe, expect, it, vi } from "vitest";

import { RigProfileStore } from "../profiles/index.js";
import { sharingProfileBind } from "../persistence/sharing/index.js";
import type { SharingSnapshot } from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { SharingLifecycleService, type ManagedSharingService } from "./SharingLifecycleService.js";

const IDENTITY = "A".repeat(43);
const REPLACEMENT_IDENTITY = "B".repeat(43);
const LOCAL_INSTANCE_ID = "alocalinstance00000000001";

describe("SharingLifecycleService", () => {
    it("does not open Murmur until onboarding enables it", async () => {
        const fixture = await createFixture();
        try {
            await fixture.lifecycle.start();
            expect(fixture.open).not.toHaveBeenCalled();
            expect(await fixture.lifecycle.configured()).toBe(false);

            await expect(fixture.lifecycle.onboardMurmur({ enabled: false })).resolves.toEqual({
                enabled: false,
            });
            expect(fixture.open).not.toHaveBeenCalled();
            expect(await fixture.lifecycle.configured()).toBe(true);
            expect(await fixture.lifecycle.enabled()).toBe(false);
        } finally {
            await fixture.lifecycle.close();
            await fixture.database.close();
        }
    });

    it("opens Murmur, binds the canonical profile, and returns its public identity", async () => {
        const fixture = await createFixture();
        const profile = await fixture.profiles.create({
            email: "steve@example.test",
            name: "Steve",
        });
        try {
            await expect(
                fixture.lifecycle.onboardMurmur({ enabled: true, profileId: profile.id }),
            ).resolves.toEqual({
                enabled: true,
                profile,
                publicKey: IDENTITY,
            });
            expect(fixture.open).toHaveBeenCalledOnce();
            expect(fixture.service.bindProfile).toHaveBeenCalledWith(profile.id);
            expect(fixture.service.start).toHaveBeenCalledOnce();
            expect(await fixture.lifecycle.enabled()).toBe(true);
        } finally {
            await fixture.lifecycle.close();
            await fixture.database.close();
        }
    });

    it("restores enabled Murmur on restart and keeps disabled restarts offline", async () => {
        const fixture = await createFixture();
        const profile = await fixture.profiles.create({
            email: "steve@example.test",
            name: "Steve",
        });
        await fixture.lifecycle.onboardMurmur({ enabled: true, profileId: profile.id });
        await fixture.lifecycle.close();

        const restoredService = fakeService(profile.id);
        const restoredOpen = vi.fn(async () => restoredService);
        const restored = new SharingLifecycleService({
            database: fixture.database,
            open: restoredOpen,
            profiles: fixture.profiles,
            resetState: async () => undefined,
        });
        try {
            await restored.start();
            expect(restoredOpen).toHaveBeenCalledOnce();
            expect(restoredService.start).toHaveBeenCalledOnce();

            await restored.onboardMurmur({ enabled: false });
            expect(restoredService.close).toHaveBeenCalledOnce();

            const disabledOpen = vi.fn(async () => fakeService(profile.id));
            const disabled = new SharingLifecycleService({
                database: fixture.database,
                open: disabledOpen,
                profiles: fixture.profiles,
                resetState: async () => undefined,
            });
            await disabled.start();
            expect(disabledOpen).not.toHaveBeenCalled();
            await disabled.close();
        } finally {
            await restored.close();
            await fixture.database.close();
        }
    });

    it("rejects a nonlocal profile before opening Murmur", async () => {
        const fixture = await createFixture();
        try {
            await expect(
                fixture.lifecycle.onboardMurmur({
                    enabled: true,
                    profileId: "amissingprofile000000000001",
                }),
            ).rejects.toThrow("profile owned by this Rig");
            expect(fixture.open).not.toHaveBeenCalled();
            expect(await fixture.lifecycle.configured()).toBe(false);
        } finally {
            await fixture.lifecycle.close();
            await fixture.database.close();
        }
    });

    it("closes and clears Murmur before reopening the same profile with a new identity", async () => {
        const fixture = await createFixture();
        const profile = await fixture.profiles.create({
            email: "steve@example.test",
            name: "Steve",
        });
        await fixture.lifecycle.onboardMurmur({ enabled: true, profileId: profile.id });
        const replacement = fakeService(profile.id, async () => undefined, REPLACEMENT_IDENTITY);
        fixture.open.mockResolvedValueOnce(replacement);
        try {
            await expect(fixture.lifecycle.reset()).resolves.toMatchObject({
                contacts: [],
                identity: REPLACEMENT_IDENTITY,
                profileId: profile.id,
            });
            expect(fixture.service.close).toHaveBeenCalledOnce();
            expect(fixture.resetState).toHaveBeenCalledOnce();
            expect(fixture.open).toHaveBeenCalledTimes(2);
            expect(replacement.bindProfile).toHaveBeenCalledWith(profile.id);
            expect(replacement.start).toHaveBeenCalledOnce();
        } finally {
            await fixture.lifecycle.close();
            await fixture.database.close();
        }
    });
});

async function createFixture() {
    const database = await PersistentSessionStore.open({
        databasePath: ":memory:",
        localInstanceId: LOCAL_INSTANCE_ID,
    });
    const profiles = new RigProfileStore({
        database,
        localInstanceId: LOCAL_INSTANCE_ID,
        publish: () => undefined,
    });
    const service = fakeService(null, async (profileId) => {
        await database.transaction((tx) => sharingProfileBind(tx, profileId, IDENTITY, 1));
    });
    const open = vi.fn(async () => service);
    const resetState = vi.fn(async () => undefined);
    return {
        database,
        lifecycle: new SharingLifecycleService({
            database,
            open,
            profiles,
            resetState,
        }),
        open,
        profiles,
        resetState,
        service,
    };
}

function fakeService(
    profileId: string | null,
    onBind: (profileId: string) => Promise<void> = async () => undefined,
    identity = IDENTITY,
): ManagedSharingService & {
    bindProfile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
} {
    const snapshot: SharingSnapshot = {
        connection: "connecting",
        contacts: [],
        folderShares: [],
        identity,
        incomingRequests: [],
        outgoingRequests: [],
        profileId,
        version: "01900000-0000-7000-8000-000000000001",
    };
    return {
        acceptContact: vi.fn(async () => undefined),
        bindProfile: vi.fn(onBind),
        close: vi.fn(async () => undefined),
        createInvitation: vi.fn(async () => ({ expiresAt: 1, invitation: IDENTITY })),
        createFolderShare: vi.fn(async () => {
            throw new Error("Not implemented by this fixture.");
        }),
        foldersChanged: vi.fn(),
        rejectContact: vi.fn(async () => undefined),
        removeContact: vi.fn(async () => undefined),
        requestContact: vi.fn(async () => ({
            id: IDENTITY,
            identity: IDENTITY,
            sessionId: IDENTITY,
        })),
        snapshot: vi.fn(async () => snapshot),
        start: vi.fn(),
    };
}
