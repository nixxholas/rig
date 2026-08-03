import { describe, expect, it, vi } from "vitest";

import { connectRig, type HappyCloudStatus } from "@/index.js";

const denied = { changedAt: 0, consent: "denied" as const };
const status: HappyCloudStatus = {
    capabilities: {
        friends: denied,
        group_chats: denied,
        happy_profile: denied,
        live_session_sharing: denied,
        remote_control: denied,
        session_blob_persistence: denied,
    },
    contractVersion: 1,
    enrollment: { changedAt: 0, state: "not_enrolled" },
    profile: { changedAt: 0, state: "not_created" },
    updatedAt: 0,
    version: 0,
};

describe("Happy Cloud API", () => {
    it("uses the optimistic mutation queue and preserves opaque ciphertext", async () => {
        const requests: Array<{ body?: unknown; headers: Headers; method: string; path: string }> =
            [];
        const enrolledStatus: HappyCloudStatus = {
            ...status,
            enrollment: { changedAt: 10, state: "enrolled" },
            updatedAt: 10,
            version: 1,
        };
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = new URL(String(input));
            requests.push({
                ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
                headers: new Headers(init?.headers),
                method: init?.method ?? "GET",
                path: url.pathname,
            });
            if (url.pathname === "/happy-cloud/profile") {
                return Response.json({ ciphertext: "profile\u0000ciphertext", version: 3 });
            }
            if (url.pathname.endsWith("/session-blobs/mobile%2Fsession")) {
                return Response.json({
                    ciphertext: "blob\nciphertext",
                    sessionId: "mobile/session",
                    version: 4,
                });
            }
            return Response.json(
                url.pathname.endsWith("/commands") ? { status: enrolledStatus } : status,
            );
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            now: () => 10,
            token: "secret",
        });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() =>
            expect(requests.some((request) => request.path.endsWith("/status"))).toBe(true),
        );
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));
        const mutationId = rig.applyHappyCloudCommand({
            action: "set_enrollment",
            state: "enrolled",
        });

        expect(cloud.status()?.enrollment.state).toBe("enrolled");
        await expect(rig.getHappyCloudStatus()).resolves.toEqual(status);
        await vi.waitFor(() => expect(cloud.status()).toEqual(enrolledStatus));
        await expect(rig.getHappyCloudProfile()).resolves.toEqual({
            ciphertext: "profile\u0000ciphertext",
            version: 3,
        });
        await expect(rig.getHappyCloudSessionBlob("mobile/session")).resolves.toEqual({
            ciphertext: "blob\nciphertext",
            sessionId: "mobile/session",
            version: 4,
        });
        expect(requests.find((entry) => entry.path.endsWith("/commands"))).toMatchObject({
            body: {
                action: "set_enrollment",
                contractVersion: 1,
                expectedVersion: 0,
                mutationId,
                state: "enrolled",
            },
            method: "POST",
        });
        expect(
            requests
                .find((entry) => entry.path.endsWith("/commands"))
                ?.headers.get("x-rig-mutation-id"),
        ).toBe(mutationId);
        expect(
            requests.every((entry) => entry.headers.get("authorization") === "Bearer secret"),
        ).toBe(true);
        cloud.close();
        rig.close();
    });

    it("retries the exact mutation and keeps independent choices in FIFO order", async () => {
        const commands: HappyCloudStatus[] = [];
        const bodies: unknown[] = [];
        let firstAttempt = true;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith("/status")) return Response.json(status);
            if (!path.endsWith("/commands")) throw new Error(`Unexpected request: ${path}`);
            const body = JSON.parse(String(init?.body));
            bodies.push(body);
            if (firstAttempt) {
                firstAttempt = false;
                throw new TypeError("response lost");
            }
            const previous = commands.at(-1) ?? status;
            const next: HappyCloudStatus =
                body.action === "set_enrollment"
                    ? {
                          ...previous,
                          enrollment: { changedAt: 20, state: "enrolled" },
                          updatedAt: 20,
                          version: 1,
                      }
                    : {
                          ...previous,
                          capabilities: {
                              ...previous.capabilities,
                              remote_control: { changedAt: 20, consent: "granted" },
                          },
                          updatedAt: 20,
                          version: 2,
                      };
            commands.push(next);
            return Response.json({ status: next });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            now: () => 20,
            token: "secret",
            wait: async () => undefined,
        });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));

        const enrollmentMutation = rig.applyHappyCloudCommand({
            action: "set_enrollment",
            state: "enrolled",
        });
        const controlMutation = rig.applyHappyCloudCommand({
            action: "set_capability",
            capability: "remote_control",
            consent: "granted",
        });

        expect(cloud.status()?.capabilities.remote_control.consent).toBe("granted");
        await vi.waitFor(() => expect(bodies).toHaveLength(3));
        expect(bodies[0]).toEqual(bodies[1]);
        expect(bodies).toMatchObject([
            { expectedVersion: 0, mutationId: enrollmentMutation },
            { expectedVersion: 0, mutationId: enrollmentMutation },
            { expectedVersion: 1, mutationId: controlMutation },
        ]);
        expect(cloud.status()).toEqual(commands[1]);
        cloud.close();
        rig.close();
    });

    it("bootstraps persisted state before stamping and delivering a mutation", async () => {
        const persisted: HappyCloudStatus = {
            ...status,
            enrollment: { changedAt: 7, state: "enrolled" },
            updatedAt: 7,
            version: 7,
        };
        let releaseStatus: ((response: Response) => void) | undefined;
        const statusResponse = new Promise<Response>((resolve) => {
            releaseStatus = resolve;
        });
        const bodies: Array<{ expectedVersion: number }> = [];
        const changes: HappyCloudStatus[] = [];
        let statusAttempts = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path.endsWith("/status")) {
                statusAttempts += 1;
                if (statusAttempts === 1) throw new TypeError("bootstrap unavailable");
                return statusResponse;
            }
            const body = JSON.parse(String(init?.body)) as { expectedVersion: number };
            bodies.push(body);
            return Response.json({
                status: {
                    ...persisted,
                    capabilities: {
                        ...persisted.capabilities,
                        friends: { changedAt: 8, consent: "granted" },
                    },
                    updatedAt: 8,
                    version: 8,
                },
            });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
            wait: async () => undefined,
        });
        const cloud = rig.connectHappyCloud({ onChange: (next) => changes.push(next) });
        rig.applyHappyCloudCommand({
            action: "set_capability",
            capability: "friends",
            consent: "granted",
        });

        expect(bodies).toEqual([]);
        expect(changes).toEqual([]);
        expect(cloud.status()).toBeUndefined();
        releaseStatus?.(Response.json(persisted));
        await vi.waitFor(() => expect(bodies).toHaveLength(1));
        expect(statusAttempts).toBe(2);
        expect(bodies[0]?.expectedVersion).toBe(7);
        expect(cloud.status()?.version).toBe(8);
        cloud.close();
        rig.close();
    });

    it("returns missing ciphertext as absent and rejects malformed status", async () => {
        const missing = connectRig({
            endpoint: "http://rig.test",
            fetch: async () => Response.json({ error: "missing" }, { status: 404 }),
            token: "secret",
        });
        await expect(missing.getHappyCloudProfile()).resolves.toBeUndefined();
        missing.close();

        const malformed = connectRig({
            endpoint: "http://rig.test",
            fetch: async () => Response.json({ enrolled: true, remoteControl: true }),
            token: "secret",
        });
        await expect(malformed.getHappyCloudStatus()).rejects.toThrow(
            "Rig returned an invalid Happy Cloud response.",
        );
        malformed.close();
    });
});
