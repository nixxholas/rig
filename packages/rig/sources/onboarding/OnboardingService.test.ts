import { describe, expect, it, vi } from "vitest";

import { onboardingMarkCompleted } from "../persistence/onboarding/onboardingMarkCompleted.js";
import { queryOnboardingState } from "../persistence/onboarding/queryOnboardingState.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { OnboardingService } from "./OnboardingService.js";

describe("OnboardingService", () => {
    it("returns provider setup before consulting the profile when no provider is configured", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        const profileComplete = vi.fn(() => true);
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete,
                providersConfigured: () => false,
            });

            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "provider_setup",
            });
            expect(profileComplete).not.toHaveBeenCalled();
        } finally {
            store.close();
        }
    });

    it("requires a profile once a provider is configured", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => false,
                providersConfigured: () => true,
            });

            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "profile_required",
            });
            expect(store.query(queryOnboardingState)).toEqual({ completedVersion: 0 });
        } finally {
            store.close();
        }
    });

    it("marks completion durably once every requirement is satisfied", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => true,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => true,
                providersConfigured: () => true,
            });

            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
            expect(store.query(queryOnboardingState)).toEqual({ completedVersion: 2 });
        } finally {
            store.close();
        }
    });

    it("uses the completion marker as a fast path without checking profile or providers", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            store.transaction((tx) => onboardingMarkCompleted(tx, 2));

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

            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
            expect(profileComplete).not.toHaveBeenCalled();
            expect(providersConfigured).not.toHaveBeenCalled();
        } finally {
            store.close();
        }
    });

    it("reopens onboarding when the required version advances", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            store.transaction((tx) => onboardingMarkCompleted(tx, 1));

            const onboarding = new OnboardingService({
                currentVersion: 2,
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => false,
                providersConfigured: () => true,
            });

            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "profile_required",
            });
        } finally {
            store.close();
        }
    });

    it("keeps completion authoritative when configuration is read concurrently", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => true,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => true,
                providersConfigured: async () => {
                    // Another caller finishes onboarding while this check is in flight.
                    store.transaction((tx) => onboardingMarkCompleted(tx, 2));
                    return false;
                },
            });

            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
        } finally {
            store.close();
        }
    });

    it("requires an explicit Murmur choice after the profile step", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        try {
            const onboarding = new OnboardingService({
                murmurConfigured: () => false,
                onboardMurmur: async () => ({ enabled: false }),
                persistence: store,
                profileComplete: () => true,
                providersConfigured: () => true,
            });

            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "murmur_setup",
            });
            expect(store.query(queryOnboardingState)).toEqual({ completedVersion: 0 });
        } finally {
            store.close();
        }
    });

    it("persists version-two completion after enabling or disabling Murmur", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
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

            await expect(onboarding.onboardMurmur({ enabled: false })).resolves.toEqual({
                enabled: false,
            });
            expect(onboardMurmur).toHaveBeenCalledWith({ enabled: false });
            expect(store.query(queryOnboardingState)).toEqual({ completedVersion: 2 });
            await expect(onboarding.status()).resolves.toEqual({
                onboardingVersion: 2,
                state: "complete",
            });
        } finally {
            store.close();
        }
    });
});
