import { createTestRootContext } from "../testing/createTestRootContext.js";
import { describe, expect, it, vi } from "vitest";

import { onboardingMarkCompleted } from "../persistence/onboarding/onboardingMarkCompleted.js";
import { queryOnboardingState } from "../persistence/onboarding/queryOnboardingState.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { OnboardingService } from "./OnboardingService.js";

const ctx = createTestRootContext().named("onboarding-service-test");

describe("OnboardingService", () => {
    it("returns provider setup before consulting the profile when no provider is configured", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        const profileComplete = vi.fn(() => true);
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete,
                providersConfigured: () => false,
            });

            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "provider_setup",
            });
            expect(profileComplete).not.toHaveBeenCalled();
        } finally {
            await store.close(ctx);
        }
    });

    it("requires a profile once a provider is configured", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => false,
                providersConfigured: () => true,
            });

            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "profile_required",
            });
            expect(await store.query(ctx, queryOnboardingState)).toEqual({ completedVersion: 0 });
        } finally {
            await store.close(ctx);
        }
    });

    it("marks completion durably once every requirement is satisfied", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => true,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => true,
                providersConfigured: () => true,
            });

            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
            expect(await store.query(ctx, queryOnboardingState)).toEqual({ completedVersion: 2 });
        } finally {
            await store.close(ctx);
        }
    });

    it("uses the completion marker as a fast path without checking profile or providers", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            await store.transaction(ctx, async (tx) => onboardingMarkCompleted(tx, 2));

            const profileComplete = vi.fn(() => {
                throw new Error("The fast path must not inspect profiles.");
            });
            const providersConfigured = vi.fn(() => {
                throw new Error("The fast path must not read provider configuration.");
            });
            const onboarding = new OnboardingService({
                murmurConfigured: () => {
                    throw new Error("The fast path must not inspect Murmur.");
                },
                onboardMurmur: async () => {
                    throw new Error("The fast path must not configure Murmur.");
                },
                persistence: store,
                profileComplete,
                providersConfigured,
            });

            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
            expect(profileComplete).not.toHaveBeenCalled();
            expect(providersConfigured).not.toHaveBeenCalled();
        } finally {
            await store.close(ctx);
        }
    });

    it("reopens onboarding when the required version advances", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            await store.transaction(ctx, async (tx) => onboardingMarkCompleted(tx, 1));

            const onboarding = new OnboardingService({
                currentVersion: 2,
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => false,
                providersConfigured: () => true,
            });

            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "profile_required",
            });
        } finally {
            await store.close(ctx);
        }
    });

    it("keeps completion authoritative when configuration is read concurrently", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => true,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => true,
                providersConfigured: async () => {
                    // Another caller finishes onboarding while this check is in flight.
                    await store.transaction(ctx, async (tx) => onboardingMarkCompleted(tx, 2));
                    return false;
                },
            });

            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
        } finally {
            await store.close(ctx);
        }
    });

    it("requires an explicit Murmur choice after the profile step", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => true,
                providersConfigured: () => true,
            });

            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "murmur_setup",
            });
            expect(await store.query(ctx, queryOnboardingState)).toEqual({ completedVersion: 0 });
        } finally {
            await store.close(ctx);
        }
    });

    it("persists version-two completion after enabling or disabling Murmur", async () => {
        const store = await PersistentSessionStore.open(ctx, {
            databasePath: ":memory:",
        });
        let configured = false;
        try {
            const onboardMurmur = vi.fn(async () => {
                configured = true;
                return { enabled: false } as const;
            });
            const onboarding = new OnboardingService({
                murmurConfigured: () => configured,
                onboardMurmur,
                persistence: store,
                profileComplete: () => true,
                providersConfigured: () => true,
            });

            await expect(onboarding.onboardMurmur(ctx, { enabled: false })).resolves.toEqual({
                enabled: false,
            });
            expect(onboardMurmur).toHaveBeenCalledWith(ctx, { enabled: false });
            expect(await store.query(ctx, queryOnboardingState)).toEqual({ completedVersion: 2 });
            await expect(onboarding.status(ctx)).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
        } finally {
            await store.close(ctx);
        }
    });
});
