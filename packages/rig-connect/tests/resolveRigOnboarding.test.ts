import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
    localRigOnboardingInspectionSchema,
    MAXIMUM_RIG_PROTOCOL_VERSION,
    MINIMUM_RIG_PROTOCOL_VERSION,
    resolveRigOnboarding,
    rigOnboardingStateSchema,
    type RigCliInstallationInspection,
    type RigDaemonInstallationDiscovery,
} from "@/index.js";

const endpoint = "http://rig.test";
const token = "secret";
const complete = { onboardingVersion: 2, state: "complete" } as const;

describe("resolveRigOnboarding", () => {
    it("returns a missing CLI before attempting daemon discovery", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();

        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () => ({ status: "not_installed" }),
                token,
            }),
        ).resolves.toEqual({ state: "rig_not_installed" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("returns an authoritatively stopped daemon before compatibility or discovery", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();

        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () => ({
                    message: "The Rig daemon is stopped.",
                    status: "not_running",
                }),
                token,
            }),
        ).resolves.toEqual({
            message: "The Rig daemon is stopped.",
            state: "rig_not_running",
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        {
            expectedUpgrade: "rig",
            protocolVersion: MINIMUM_RIG_PROTOCOL_VERSION - 1,
        },
        {
            expectedUpgrade: "happy",
            protocolVersion: MAXIMUM_RIG_PROTOCOL_VERSION + 1,
        },
    ] as const)(
        "uses the CLI protocol to request a $expectedUpgrade upgrade before daemon discovery",
        async ({ expectedUpgrade, protocolVersion }) => {
            const fetch = vi.fn<typeof globalThis.fetch>();

            const status = await resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () => inspection({ cliProtocolVersion: protocolVersion }),
                token,
            });

            expect(status).toMatchObject({
                protocolVersion,
                reason: "protocol",
                source: "cli",
                state: "version_mismatch",
                upgrade: expectedUpgrade,
            });
            expect(fetch).not.toHaveBeenCalled();
        },
    );

    it("classifies local installation data before contacting a daemon", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();

        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () => inspection({ data: { status: "absent" } }),
                token,
            }),
        ).resolves.toEqual({ state: "rig_not_running" });
        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () =>
                    inspection({
                        data: {
                            message:
                                "Existing Rig data needs an upgrade before its stable identity is available.",
                            reason: "pre_identity",
                            schemaVersion: 16,
                            status: "upgrade_required",
                        },
                    }),
                token,
            }),
        ).resolves.toEqual({ state: "rig_not_running" });
        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () =>
                    inspection({
                        data: {
                            epoch: "installation-epoch",
                            schemaCompatibility: "upgrade_required",
                            schemaVersion: 41,
                            status: "initialized",
                        },
                    }),
                token,
            }),
        ).resolves.toEqual({ state: "rig_not_running" });
        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () =>
                    inspection({
                        data: {
                            message: "This database was created by a newer Rig.",
                            reason: "newer_schema",
                            schemaVersion: 99,
                            status: "incompatible",
                        },
                    }),
                token,
            }),
        ).resolves.toEqual({
            dataReason: "newer_schema",
            installedVersion: "0.1.8",
            message: "This database was created by a newer Rig.",
            reason: "installation_data",
            schemaVersion: 99,
            source: "cli",
            state: "version_mismatch",
            upgrade: "rig",
        });
        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch,
                inspectLocalRig: () =>
                    inspection({
                        data: {
                            message: "Rig data is busy.",
                            reason: "busy",
                            status: "unavailable",
                        },
                    }),
                token,
            }),
        ).resolves.toEqual({
            message: "Rig data is busy.",
            state: "rig_unreachable",
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        {
            daemonProtocolVersion: MINIMUM_RIG_PROTOCOL_VERSION - 1,
            expectedUpgrade: "rig",
        },
        {
            daemonProtocolVersion: MAXIMUM_RIG_PROTOCOL_VERSION + 1,
            expectedUpgrade: "happy",
        },
    ] as const)(
        "uses daemon compatibility to request a $expectedUpgrade upgrade before onboarding",
        async ({ daemonProtocolVersion, expectedUpgrade }) => {
            const paths: string[] = [];
            const status = await resolveRigOnboarding({
                endpoint,
                fetch: async (input) => {
                    const path = new URL(String(input)).pathname;
                    paths.push(path);
                    return Response.json(discovery({ daemonProtocolVersion }));
                },
                inspectLocalRig: () => inspection(),
                token,
            });

            expect(status).toMatchObject({
                protocolVersion: daemonProtocolVersion,
                reason: "protocol",
                source: "daemon",
                state: "version_mismatch",
                upgrade: expectedUpgrade,
            });
            expect(paths).toEqual(["/installation"]);
        },
    );

    it("classifies a daemon that predates discovery as requiring a Rig upgrade", async () => {
        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch: async () => new Response(null, { status: 404 }),
                inspectLocalRig: () => inspection(),
                token,
            }),
        ).resolves.toMatchObject({
            protocolVersion: 0,
            source: "daemon",
            state: "version_mismatch",
            upgrade: "rig",
        });
    });

    it("distinguishes an unreachable daemon without guessing that the CLI is absent", async () => {
        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch: async () => {
                    throw new TypeError("Connection refused.");
                },
                inspectLocalRig: () => inspection(),
                token,
            }),
        ).resolves.toEqual({
            message: "Connection refused.",
            state: "rig_unreachable",
        });
    });

    it("returns the daemon-owned status only after inspection, discovery, and compatibility", async () => {
        const order: string[] = [];
        const status = await resolveRigOnboarding({
            endpoint,
            fetch: async (input) => {
                const path = new URL(String(input)).pathname;
                order.push(path);
                return path === "/installation"
                    ? Response.json(discovery())
                    : Response.json(complete);
            },
            inspectLocalRig: () => {
                order.push("inspect");
                return inspection();
            },
            token,
        });

        expect(status).toEqual(complete);
        expect(order).toEqual(["inspect", "/installation", "/onboarding"]);
    });

    it("bounds the final daemon-owned status request", async () => {
        vi.useFakeTimers();
        try {
            const onboardingStarted = deferred<void>();
            const resolution = resolveRigOnboarding({
                endpoint,
                fetch: async (input, init) => {
                    if (new URL(String(input)).pathname === "/installation") {
                        return Response.json(discovery());
                    }
                    onboardingStarted.resolve();
                    return new Promise<Response>((_resolve, reject) => {
                        const abort = () =>
                            reject(
                                init?.signal?.reason ??
                                    new DOMException("The request timed out.", "TimeoutError"),
                            );
                        if (init?.signal?.aborted === true) abort();
                        else init?.signal?.addEventListener("abort", abort, { once: true });
                    });
                },
                inspectLocalRig: () => inspection(),
                timeoutMs: 1,
                token,
            });
            await onboardingStarted.promise;

            await vi.advanceTimersByTimeAsync(1);

            await expect(resolution).resolves.toEqual({
                message: "Rig onboarding status timed out.",
                state: "rig_unreachable",
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects a daemon from a different local data epoch before reading onboarding", async () => {
        const paths: string[] = [];
        await expect(
            resolveRigOnboarding({
                endpoint,
                fetch: async (input) => {
                    paths.push(new URL(String(input)).pathname);
                    return Response.json(discovery({ epoch: "different-installation" }));
                },
                inspectLocalRig: () => inspection(),
                token,
            }),
        ).resolves.toMatchObject({
            state: "rig_unreachable",
        });
        expect(paths).toEqual(["/installation"]);
    });

    it("preserves caller cancellation instead of presenting it as unreachable", async () => {
        const controller = new AbortController();
        const reason = new Error("The onboarding view closed.");
        controller.abort(reason);
        const inspectLocalRig = vi.fn(() => inspection());

        await expect(
            resolveRigOnboarding({
                endpoint,
                inspectLocalRig,
                signal: controller.signal,
                token,
            }),
        ).rejects.toBe(reason);
        expect(inspectLocalRig).not.toHaveBeenCalled();
    });

    it("runtime-validates native inputs and every public output variant", async () => {
        expect(Value.Check(localRigOnboardingInspectionSchema, { status: "not_installed" })).toBe(
            true,
        );
        expect(
            Value.Check(localRigOnboardingInspectionSchema, {
                status: "not_installed",
                unexpected: true,
            }),
        ).toBe(false);
        expect(Value.Check(rigOnboardingStateSchema, { state: "rig_not_installed" })).toBe(true);
        expect(Value.Check(rigOnboardingStateSchema, complete)).toBe(true);
        expect(Value.Check(rigOnboardingStateSchema, { state: "unknown" })).toBe(false);
        const installationDataMismatch = {
            dataReason: "newer_schema",
            installedVersion: "0.1.8",
            message: "Install a compatible Rig version.",
            reason: "installation_data",
            schemaVersion: 99,
            source: "cli",
            state: "version_mismatch",
            upgrade: "rig",
        } as const;
        expect(Value.Check(rigOnboardingStateSchema, installationDataMismatch)).toBe(true);
        expect(
            Value.Check(rigOnboardingStateSchema, {
                ...installationDataMismatch,
                maximumSupportedProtocolVersion: MAXIMUM_RIG_PROTOCOL_VERSION,
                minimumSupportedProtocolVersion: MINIMUM_RIG_PROTOCOL_VERSION,
                protocolVersion: MINIMUM_RIG_PROTOCOL_VERSION,
            }),
        ).toBe(false);
        expect(
            Value.Check(rigOnboardingStateSchema, {
                installedVersion: "0.1.8",
                reason: "protocol",
                source: "cli",
                state: "version_mismatch",
                upgrade: "rig",
            }),
        ).toBe(false);

        await expect(
            resolveRigOnboarding({
                endpoint,
                inspectLocalRig: () => ({ status: "unknown" }) as never,
                token,
            }),
        ).rejects.toThrow("invalid Rig installation inspection");
    });
});

function inspection(
    overrides: Partial<RigCliInstallationInspection> = {},
): RigCliInstallationInspection {
    return {
        cliProtocolVersion: MINIMUM_RIG_PROTOCOL_VERSION,
        cliVersion: "0.1.8",
        data: {
            epoch: "installation-epoch",
            schemaCompatibility: "current",
            schemaVersion: 42,
            status: "initialized",
        },
        formatVersion: 1,
        source: "cli",
        ...overrides,
    };
}

function discovery(
    overrides: {
        daemonProtocolVersion?: number;
        epoch?: string;
    } = {},
): RigDaemonInstallationDiscovery {
    return {
        daemonProtocolVersion: overrides.daemonProtocolVersion ?? MINIMUM_RIG_PROTOCOL_VERSION,
        daemonVersion: "0.1.8",
        data: {
            epoch: overrides.epoch ?? "installation-epoch",
            schemaCompatibility: "current",
            schemaVersion: 42,
            status: "initialized",
        },
        formatVersion: 1,
        source: "daemon",
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((onResolve) => {
        resolve = onResolve;
    });
    return { promise, resolve };
}
