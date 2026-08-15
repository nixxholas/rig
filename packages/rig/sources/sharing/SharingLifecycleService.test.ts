import { createTestRootContext } from "../testing/createTestRootContext.js";
import { describe, expect, it, vi } from "vitest";

import { RigProfileStore } from "../profiles/index.js";
import { sharingProfileBind } from "../persistence/sharing/index.js";
import type { SharingSnapshot } from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { SharingLifecycleService, type ManagedSharingService } from "./SharingLifecycleService.js";

const IDENTITY = "A".repeat(43);
const REPLACEMENT_IDENTITY = "B".repeat(43);
const LOCAL_INSTANCE_ID = "alocalinstance00000000001";
const ctx = createTestRootContext().named("sharing-lifecycle-service-test");

describe("SharingLifecycleService", () => {
    it("does not open Murmur until onboarding enables it", async () => {
        const fixture = await createFixture();
        try {
            await fixture.lifecycle.start(ctx);
            expect(fixture.open).not.toHaveBeenCalled();
            expect(await fixture.lifecycle.configured(ctx)).toBe(false);

            await expect(fixture.lifecycle.onboardMurmur(ctx, { enabled: false })).resolves.toEqual(
                {
                    enabled: false,
                },
            );
            expect(fixture.open).not.toHaveBeenCalled();
            expect(await fixture.lifecycle.configured(ctx)).toBe(true);
            expect(await fixture.lifecycle.enabled(ctx)).toBe(false);
        } finally {
            await fixture.lifecycle.close(ctx);
            await fixture.database.close(ctx);
        }
    });

    it("opens Murmur, binds the canonical profile, and returns its public identity", async () => {
        const fixture = await createFixture();
        const profile = await fixture.profiles.create(ctx, {
            email: "steve@example.test",
            name: "Steve",
        });
        try {
            await expect(
                fixture.lifecycle.onboardMurmur(ctx, { enabled: true, profileId: profile.id }),
            ).resolves.toEqual({
                enabled: true,
                profile,
                publicKey: IDENTITY,
            });
            expect(fixture.open).toHaveBeenCalledOnce();
            expect(fixture.service.bindProfile).toHaveBeenCalledWith(ctx, profile.id);
            expect(fixture.service.start).toHaveBeenCalledOnce();
            expect(await fixture.lifecycle.enabled(ctx)).toBe(true);
        } finally {
            await fixture.lifecycle.close(ctx);
            await fixture.database.close(ctx);
        }
    });

    it("keeps folder-change work inside the caller operation", async () => {
        const fixture = await createFixture();
        const profile = await fixture.profiles.create(ctx, {
            email: "steve@example.test",
            name: "Steve",
        });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        fixture.service.foldersChanged.mockReturnValueOnce(pending);
        try {
            await fixture.lifecycle.onboardMurmur(ctx, { enabled: true, profileId: profile.id });

            const changed = fixture.lifecycle.foldersChanged(ctx);
            let settled = false;
            void changed.then(() => {
                settled = true;
            });
            await Promise.resolve();
            expect(settled).toBe(false);

            release();
            await expect(changed).resolves.toBeUndefined();
            expect(fixture.service.foldersChanged).toHaveBeenCalledWith(ctx);
        } finally {
            await fixture.lifecycle.close(ctx);
            await fixture.database.close(ctx);
        }
    });

    it("restores enabled Murmur on restart and keeps disabled restarts offline", async () => {
        const fixture = await createFixture();
        const profile = await fixture.profiles.create(ctx, {
            email: "steve@example.test",
            name: "Steve",
        });
        await fixture.lifecycle.onboardMurmur(ctx, { enabled: true, profileId: profile.id });
        await fixture.lifecycle.close(ctx);

        const restoredService = fakeService(profile.id);
        const restoredOpen = vi.fn(async () => restoredService);
        const restored = new SharingLifecycleService({
            database: fixture.database,
            open: restoredOpen,
            profiles: fixture.profiles,
            resetState: async () => undefined,
        });
        try {
            await restored.start(ctx);
            expect(restoredOpen).toHaveBeenCalledOnce();
            expect(restoredService.start).toHaveBeenCalledOnce();

            await restored.onboardMurmur(ctx, { enabled: false });
            expect(restoredService.close).toHaveBeenCalledOnce();

            const disabledOpen = vi.fn(async () => fakeService(profile.id));
            const disabled = new SharingLifecycleService({
                database: fixture.database,
                open: disabledOpen,
                profiles: fixture.profiles,
                resetState: async () => undefined,
            });
            await disabled.start(ctx);
            expect(disabledOpen).not.toHaveBeenCalled();
            await disabled.close(ctx);
        } finally {
            await restored.close(ctx);
            await fixture.database.close(ctx);
        }
    });

    it("rejects a nonlocal profile before opening Murmur", async () => {
        const fixture = await createFixture();
        try {
            await expect(
                fixture.lifecycle.onboardMurmur(ctx, {
                    enabled: true,
                    profileId: "amissingprofile000000000001",
                }),
            ).rejects.toThrow("profile owned by this Rig");
            expect(fixture.open).not.toHaveBeenCalled();
            expect(await fixture.lifecycle.configured(ctx)).toBe(false);
        } finally {
            await fixture.lifecycle.close(ctx);
            await fixture.database.close(ctx);
        }
    });

    it("closes and clears Murmur before reopening the same profile with a new identity", async () => {
        const fixture = await createFixture();
        const profile = await fixture.profiles.create(ctx, {
            email: "steve@example.test",
            name: "Steve",
        });
        await fixture.lifecycle.onboardMurmur(ctx, { enabled: true, profileId: profile.id });
        const replacement = fakeService(profile.id, async () => undefined, REPLACEMENT_IDENTITY);
        fixture.open.mockResolvedValueOnce(replacement);
        try {
            await expect(fixture.lifecycle.reset(ctx)).resolves.toMatchObject({
                contacts: [],
                identity: REPLACEMENT_IDENTITY,
                profileId: profile.id,
            });
            expect(fixture.service.close).toHaveBeenCalledOnce();
            expect(fixture.resetState).toHaveBeenCalledOnce();
            expect(fixture.open).toHaveBeenCalledTimes(2);
            expect(replacement.bindProfile).toHaveBeenCalledWith(ctx, profile.id);
            expect(replacement.start).toHaveBeenCalledOnce();
        } finally {
            await fixture.lifecycle.close(ctx);
            await fixture.database.close(ctx);
        }
    });
});

async function createFixture() {
    const database = await PersistentSessionStore.open(ctx, {
        databasePath: ":memory:",
        localInstanceId: LOCAL_INSTANCE_ID,
    });
    const profiles = new RigProfileStore({
        database,
        localInstanceId: LOCAL_INSTANCE_ID,
        publish: () => undefined,
    });
    const service = fakeService(null, async (requestCtx, profileId) => {
        await database.transaction(requestCtx, (txCtx) =>
            sharingProfileBind(txCtx, profileId, IDENTITY, 1),
        );
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
    onBind: (requestCtx: typeof ctx, profileId: string) => Promise<void> = async () => undefined,
    identity = IDENTITY,
): ManagedSharingService & {
    bindProfile: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    foldersChanged: ReturnType<typeof vi.fn>;
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
        foldersChanged: vi.fn(async () => undefined),
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
