import { describe, expect, it, vi } from "vitest";

import { RigProfileStore } from "../profiles/index.js";
import { sharingProfileBind } from "../persistence/sharing/index.js";
import type { SharingSnapshot } from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { SharingLifecycleService, type ManagedSharingService } from "./SharingLifecycleService.js";

const IDENTITY = "A".repeat(43);
const LOCAL_INSTANCE_ID = "alocalinstance00000000001";

describe("SharingLifecycleService", () => {
    it("does not open Murmur until onboarding enables it", async () => {
        const fixture = createFixture();
        try {
            await fixture.lifecycle.start();
            expect(fixture.open).not.toHaveBeenCalled();
            expect(fixture.lifecycle.configured()).toBe(false);

            await expect(fixture.lifecycle.onboardMurmur({ enabled: false })).resolves.toEqual({
                enabled: false,
            });
            expect(fixture.open).not.toHaveBeenCalled();
            expect(fixture.lifecycle.configured()).toBe(true);
            expect(fixture.lifecycle.enabled()).toBe(false);
        } finally {
            await fixture.lifecycle.close();
            fixture.database.close();
        }
    });

    it("opens Murmur, binds the canonical profile, and returns its public identity", async () => {
        const fixture = createFixture();
        const profile = fixture.profiles.create({
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
            expect(fixture.lifecycle.enabled()).toBe(true);
        } finally {
            await fixture.lifecycle.close();
            fixture.database.close();
        }
    });

    it("restores enabled Murmur on restart and keeps disabled restarts offline", async () => {
        const fixture = createFixture();
        const profile = fixture.profiles.create({
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
            });
            await disabled.start();
            expect(disabledOpen).not.toHaveBeenCalled();
            await disabled.close();
        } finally {
            await restored.close();
            fixture.database.close();
        }
    });

    it("rejects a nonlocal profile before opening Murmur", async () => {
        const fixture = createFixture();
        try {
            await expect(
                fixture.lifecycle.onboardMurmur({
                    enabled: true,
                    profileId: "amissingprofile000000000001",
                }),
            ).rejects.toThrow("profile owned by this Rig");
            expect(fixture.open).not.toHaveBeenCalled();
            expect(fixture.lifecycle.configured()).toBe(false);
        } finally {
            await fixture.lifecycle.close();
            fixture.database.close();
        }
    });
});

function createFixture() {
    const database = new PersistentSessionStore({
        databasePath: ":memory:",
        localInstanceId: LOCAL_INSTANCE_ID,
    });
    const profiles = new RigProfileStore({
        database,
        localInstanceId: LOCAL_INSTANCE_ID,
        publish: () => undefined,
    });
    const service = fakeService(null, (profileId) => {
        database.transaction((tx) => sharingProfileBind(tx, profileId, IDENTITY, 1));
    });
    const open = vi.fn(async () => service);
    return {
        database,
        lifecycle: new SharingLifecycleService({ database, open, profiles }),
        open,
        profiles,
        service,
    };
}

function fakeService(
    profileId: string | null,
    onBind: (profileId: string) => void = () => undefined,
): ManagedSharingService & {
    bindProfile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
} {
    const snapshot: SharingSnapshot = {
        connection: "connecting",
        contacts: [],
        folderShares: [],
        identity: IDENTITY,
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
