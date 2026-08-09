import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import { connectRig, onboardingStatusSchema, type OnboardingStatus } from "@/index.js";

const providerSetup: OnboardingStatus = {
    onboardingVersion: 2,
    state: "provider_setup",
};
const profileRequired: OnboardingStatus = {
    onboardingVersion: 2,
    state: "profile_required",
};

describe("onboarding status", () => {
    it("strictly decodes the mirrored status contract", () => {
        expect(Value.Decode(onboardingStatusSchema, profileRequired)).toEqual(profileRequired);
        expect(
            Value.Check(onboardingStatusSchema, {
                ...providerSetup,
                unexpected: true,
            }),
        ).toBe(false);
    });

    it("materializes a fresh status for every explicit query without opening a live stream", async () => {
        const paths: string[] = [];
        let reads = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            reads += 1;
            return Response.json(reads === 1 ? providerSetup : profileRequired);
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });

        await expect(rig.getOnboardingStatus()).resolves.toEqual(providerSetup);
        await expect(rig.getOnboardingStatus()).resolves.toEqual(profileRequired);
        expect(paths).toEqual(["/onboarding", "/onboarding"]);

        rig.close();
    });

    it("validates responses and preserves caller cancellation", async () => {
        const invalid = connectRig({
            endpoint: "http://rig.test",
            fetch: async () => Response.json({ onboardingVersion: 2, state: "unknown" }),
            token: "secret",
        });
        await expect(invalid.getOnboardingStatus()).rejects.toThrow(
            "Rig returned an invalid onboarding status.",
        );
        invalid.close();

        const controller = new AbortController();
        const reason = new Error("The onboarding screen closed.");
        controller.abort(reason);
        const cancelled = connectRig({
            endpoint: "http://rig.test",
            fetch: async (_input, init) => {
                init?.signal?.throwIfAborted();
                return Response.json(providerSetup);
            },
            token: "secret",
        });
        await expect(cancelled.getOnboardingStatus({ signal: controller.signal })).rejects.toBe(
            reason,
        );
        cancelled.close();

        const bodyController = new AbortController();
        const bodyReason = new Error("The onboarding screen closed while reading.");
        const delayedBody = connectRig({
            endpoint: "http://rig.test",
            fetch: async (_input, init) =>
                new Response(
                    new ReadableStream({
                        start(stream) {
                            init?.signal?.addEventListener(
                                "abort",
                                () => stream.error(init.signal?.reason),
                                { once: true },
                            );
                        },
                    }),
                    { headers: { "content-type": "application/json" } },
                ),
            token: "secret",
        });
        const delayedStatus = delayedBody.getOnboardingStatus({ signal: bodyController.signal });
        bodyController.abort(bodyReason);
        await expect(delayedStatus).rejects.toBe(bodyReason);
        delayedBody.close();
    });

    it("submits and validates the explicit Murmur choice", async () => {
        const calls: { body: unknown; method: string | undefined; path: string }[] = [];
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input, init) => {
                calls.push({
                    body: JSON.parse(String(init?.body)),
                    method: init?.method,
                    path: new URL(String(input)).pathname,
                });
                return Response.json({ enabled: false });
            },
            token: "secret",
        });

        await expect(rig.onboardMurmur({ enabled: false })).resolves.toEqual({
            enabled: false,
        });
        expect(calls).toEqual([
            {
                body: { enabled: false },
                method: "PUT",
                path: "/onboarding/murmur",
            },
        ]);
        rig.close();
    });
});
