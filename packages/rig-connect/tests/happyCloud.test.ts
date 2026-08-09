import { describe, expect, it, vi } from "vitest";

import { connectRig, type HappyCloudStatus } from "@/index.js";

const denied = { changedAt: 0, consent: "denied" as const };
const status: HappyCloudStatus = {
    authority: "local_record_only",
    capabilities: {
        group_chats: denied,
        happy_profile: denied,
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
            if (url.pathname === "/events/live") return liveResponse(init?.signal);
            requests.push({
                ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
                headers: new Headers(init?.headers),
                method: init?.method ?? "GET",
                path: url.pathname,
            });
            if (url.pathname === "/happy-cloud/profile") {
                return Response.json({ ciphertext: "cHJvZmlsZV9jaXBoZXJ0ZXh0", version: 3 });
            }
            if (url.pathname.endsWith("/session-blobs/mobile%2Fsession")) {
                return Response.json({
                    ciphertext: "YmxvYl9jaXBoZXJ0ZXh0",
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
            ciphertext: "cHJvZmlsZV9jaXBoZXJ0ZXh0",
            version: 3,
        });
        await expect(rig.getHappyCloudSessionBlob("mobile/session")).resolves.toEqual({
            ciphertext: "YmxvYl9jaXBoZXJ0ZXh0",
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
            if (path === "/events/live") return liveResponse(init?.signal);
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
            if (path === "/events/live") return liveResponse(init?.signal);
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
            capability: "remote_control",
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

    it("converges immediately from a lightweight event and rebases a version conflict once", async () => {
        const encoder = new TextEncoder();
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        let authoritative = status;
        const attempts: Array<{ expectedVersion: number; mutationId: string }> = [];
        let statusReads = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streamController = controller;
                            controller.enqueue(
                                encoder.encode(
                                    `event: hello\ndata: ${JSON.stringify({
                                        cursor: "cloud-0",
                                        gap: false,
                                        protocolVersion: 15,
                                        resumed: false,
                                    })}\n\n`,
                                ),
                            );
                            init?.signal?.addEventListener("abort", () => controller.close(), {
                                once: true,
                            });
                        },
                    }),
                );
            }
            if (path.endsWith("/status")) {
                statusReads += 1;
                return Response.json(authoritative);
            }
            const body = JSON.parse(String(init?.body)) as {
                expectedVersion: number;
                mutationId: string;
            };
            attempts.push(body);
            if (attempts.length === 1) {
                authoritative = {
                    ...authoritative,
                    capabilities: {
                        ...authoritative.capabilities,
                        remote_control: { changedAt: 2, consent: "granted" },
                    },
                    updatedAt: 2,
                    version: 2,
                };
                return Response.json(
                    {
                        code: "version_conflict",
                        error: "changed",
                        status: authoritative,
                    },
                    { status: 409 },
                );
            }
            authoritative = {
                ...authoritative,
                capabilities: {
                    ...authoritative.capabilities,
                },
                updatedAt: 3,
                version: 3,
            };
            return Response.json({ status: authoritative });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));

        authoritative = {
            ...status,
            enrollment: { changedAt: 1, state: "enrolled" },
            updatedAt: 1,
            version: 1,
        };
        streamController.enqueue(
            encoder.encode(
                `id: cloud-1\nevent: update\ndata: ${JSON.stringify({
                    cursor: "cloud-1",
                    event: {
                        createdAt: 1,
                        data: { mutationId: "other-client", version: 1 },
                        id: "cloud-event-1",
                        type: "happy_cloud_changed",
                    },
                })}\n\n`,
            ),
        );
        await vi.waitFor(() => expect(cloud.status()).toEqual(authoritative));
        expect(statusReads).toBe(2);

        const mutationId = rig.applyHappyCloudCommand({
            action: "set_capability",
            capability: "remote_control",
            consent: "granted",
        });
        await vi.waitFor(() => expect(attempts).toHaveLength(2));
        expect(attempts).toMatchObject([
            { expectedVersion: 1, mutationId },
            { expectedVersion: 2, mutationId },
        ]);
        expect(cloud.status()).toEqual(authoritative);
        cloud.close();
        rig.close();
    });

    it("converges two clients through the shared live event without polling", async () => {
        const encoder = new TextEncoder();
        const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
        let authoritative = status;
        let eventNumber = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streams.push(controller);
                            controller.enqueue(
                                encoder.encode(
                                    `event: hello\ndata: ${JSON.stringify({
                                        cursor: `hello-${String(streams.length)}`,
                                        gap: false,
                                        protocolVersion: 15,
                                        resumed: false,
                                    })}\n\n`,
                                ),
                            );
                            init?.signal?.addEventListener("abort", () => controller.close(), {
                                once: true,
                            });
                        },
                    }),
                );
            }
            if (path.endsWith("/status")) return Response.json(authoritative);
            const command = JSON.parse(String(init?.body)) as {
                expectedVersion: number;
                mutationId: string;
            };
            if (command.expectedVersion !== authoritative.version) {
                return Response.json(
                    {
                        code: "version_conflict",
                        error: "changed",
                        status: authoritative,
                    },
                    { status: 409 },
                );
            }
            authoritative = {
                ...authoritative,
                enrollment: { changedAt: 1, state: "enrolled" },
                updatedAt: 1,
                version: authoritative.version + 1,
            };
            eventNumber += 1;
            const cursor = `cloud-${String(eventNumber)}`;
            const frame = encoder.encode(
                `id: ${cursor}\nevent: update\ndata: ${JSON.stringify({
                    cursor,
                    event: {
                        createdAt: 1,
                        data: {
                            mutationId: command.mutationId,
                            version: authoritative.version,
                        },
                        id: `event-${cursor}`,
                        type: "happy_cloud_changed",
                    },
                })}\n\n`,
            );
            for (const stream of streams) stream.enqueue(frame);
            return Response.json({ status: authoritative });
        });
        const firstRig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const secondRig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const first = firstRig.connectHappyCloud({ onChange: vi.fn() });
        const second = secondRig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() => {
            expect(first.status()).toEqual(status);
            expect(second.status()).toEqual(status);
        });

        secondRig.applyHappyCloudCommand({
            action: "set_enrollment",
            state: "enrolled",
        });
        await vi.waitFor(() => {
            expect(first.status()).toEqual(authoritative);
            expect(second.status()).toEqual(authoritative);
        });
        expect(streams).toHaveLength(2);
        first.close();
        second.close();
        firstRig.close();
        secondRig.close();
    });

    it("replaces an optimistic mutation with its authoritative self-echo after a lost response", async () => {
        const encoder = new TextEncoder();
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        let authoritative = status;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streamController = controller;
                            controller.enqueue(
                                encoder.encode(
                                    `event: hello\ndata: ${JSON.stringify({
                                        cursor: "self-0",
                                        gap: false,
                                        protocolVersion: 15,
                                        resumed: false,
                                    })}\n\n`,
                                ),
                            );
                            init?.signal?.addEventListener("abort", () => controller.close(), {
                                once: true,
                            });
                        },
                    }),
                );
            }
            if (path.endsWith("/status")) return Response.json(authoritative);
            const command = JSON.parse(String(init?.body)) as { mutationId: string };
            authoritative = {
                ...authoritative,
                enrollment: { changedAt: 999, state: "enrolled" },
                updatedAt: 999,
                version: 1,
            };
            streamController.enqueue(
                encoder.encode(
                    `id: self-1\nevent: update\ndata: ${JSON.stringify({
                        cursor: "self-1",
                        event: {
                            createdAt: 999,
                            data: { mutationId: command.mutationId, version: 1 },
                            id: "self-event-1",
                            type: "happy_cloud_changed",
                        },
                    })}\n\n`,
                ),
            );
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    "abort",
                    () => reject(new DOMException("aborted", "AbortError")),
                    { once: true },
                );
            });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            now: () => 10,
            token: "secret",
        });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));
        rig.applyHappyCloudCommand({ action: "set_enrollment", state: "enrolled" });
        expect(cloud.status()?.enrollment.changedAt).toBe(10);
        await vi.waitFor(() => expect(cloud.status()).toEqual(authoritative));
        expect(cloud.status()?.enrollment.changedAt).toBe(999);
        cloud.close();
        rig.close();
    });

    it("never lets a delayed POST response roll authoritative state backward", async () => {
        const encoder = new TextEncoder();
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        const base: HappyCloudStatus = {
            ...status,
            enrollment: { changedAt: 5, state: "enrolled" },
            updatedAt: 5,
            version: 5,
        };
        const commandStatus: HappyCloudStatus = {
            ...base,
            capabilities: {
                ...base.capabilities,
            },
            updatedAt: 6,
            version: 6,
        };
        let authoritative = base;
        let releasePost: ((response: Response) => void) | undefined;
        const postResponse = new Promise<Response>((resolve) => {
            releasePost = resolve;
        });
        let postStarted = false;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streamController = controller;
                            controller.enqueue(
                                encoder.encode(
                                    `event: hello\ndata: ${JSON.stringify({
                                        cursor: "rollback-0",
                                        gap: false,
                                        protocolVersion: 15,
                                        resumed: false,
                                    })}\n\n`,
                                ),
                            );
                            init?.signal?.addEventListener("abort", () => controller.close(), {
                                once: true,
                            });
                        },
                    }),
                );
            }
            if (path.endsWith("/status")) return Response.json(authoritative);
            postStarted = true;
            return postResponse;
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() => expect(cloud.status()).toEqual(base));
        rig.applyHappyCloudCommand({
            action: "set_capability",
            capability: "remote_control",
            consent: "granted",
        });
        await vi.waitFor(() => expect(postStarted).toBe(true));

        authoritative = {
            ...commandStatus,
            capabilities: {
                ...commandStatus.capabilities,
                remote_control: { changedAt: 7, consent: "granted" },
            },
            updatedAt: 7,
            version: 7,
        };
        streamController.enqueue(
            encoder.encode(
                `id: rollback-1\nevent: update\ndata: ${JSON.stringify({
                    cursor: "rollback-1",
                    event: {
                        createdAt: 7,
                        data: { mutationId: "other-client", version: 7 },
                        id: "rollback-event-1",
                        type: "happy_cloud_changed",
                    },
                })}\n\n`,
            ),
        );
        await vi.waitFor(() =>
            expect(cloud.status()).toMatchObject({
                capabilities: { remote_control: { consent: "granted" } },
                version: 8,
            }),
        );
        releasePost?.(Response.json({ status: commandStatus }));
        await vi.waitFor(() => expect(cloud.status()).toEqual(authoritative));
        expect(cloud.status()?.version).toBe(7);
        cloud.close();
        rig.close();
    });

    it("resets to a lower authoritative version after a stream gap without stranding an echo", async () => {
        const encoder = new TextEncoder();
        const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
        const closedControllers = new WeakSet<ReadableStreamDefaultController<Uint8Array>>();
        const base: HappyCloudStatus = {
            ...status,
            enrollment: { changedAt: 5, state: "enrolled" },
            updatedAt: 5,
            version: 5,
        };
        let authoritative = base;
        let statusReads = 0;
        let liveRequests = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                const gap = liveRequests > 0;
                liveRequests += 1;
                let open = true;
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controllers.push(controller);
                            controller.enqueue(
                                encoder.encode(
                                    `event: hello\ndata: ${JSON.stringify({
                                        cursor: `gap-${liveRequests}`,
                                        gap,
                                        protocolVersion: 15,
                                        resumed: gap,
                                    })}\n\n`,
                                ),
                            );
                            init?.signal?.addEventListener(
                                "abort",
                                () => {
                                    if (!open || closedControllers.has(controller)) return;
                                    open = false;
                                    closedControllers.add(controller);
                                    controller.close();
                                },
                                { once: true },
                            );
                        },
                        cancel() {
                            open = false;
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                );
            }
            if (path.endsWith("/status")) {
                statusReads += 1;
                return Response.json(authoritative);
            }
            const command = JSON.parse(String(init?.body)) as { mutationId: string };
            controllers[0]?.enqueue(
                encoder.encode(
                    `id: gap-echo\nevent: update\ndata: ${JSON.stringify({
                        cursor: "gap-echo",
                        event: {
                            createdAt: 6,
                            data: { mutationId: command.mutationId, version: 6 },
                            id: "gap-echo-event",
                            type: "happy_cloud_changed",
                        },
                    })}\n\n`,
                ),
            );
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    "abort",
                    () => reject(new DOMException("aborted", "AbortError")),
                    { once: true },
                );
            });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
            wait: async (milliseconds, signal) => {
                if (milliseconds < 100) return;
                await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), { once: true }),
                );
            },
        });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() => expect(cloud.status()).toEqual(base));
        rig.applyHappyCloudCommand({
            action: "set_capability",
            capability: "remote_control",
            consent: "granted",
        });
        await vi.waitFor(() => expect(statusReads).toBe(2));

        authoritative = status;
        const firstController = controllers[0];
        if (firstController !== undefined) {
            closedControllers.add(firstController);
            firstController.close();
        }
        await vi.waitFor(() => expect(liveRequests).toBe(2));
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));
        cloud.close();
        rig.close();
    });

    it("bounds repeated conflict rebases and rejects instead of livelocking", async () => {
        const attempts: Array<{ expectedVersion: number; mutationId: string }> = [];
        const rejected = vi.fn();
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") return liveResponse(init?.signal);
            if (path.endsWith("/status")) return Response.json(status);
            const command = JSON.parse(String(init?.body)) as {
                expectedVersion: number;
                mutationId: string;
            };
            attempts.push(command);
            const version = attempts.length;
            return Response.json(
                {
                    code: "version_conflict",
                    error: "changed again",
                    status: {
                        ...status,
                        enrollment: { changedAt: version, state: "enrolled" },
                        updatedAt: version,
                        version,
                    },
                },
                { status: 409 },
            );
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            onMutationRejected: rejected,
            token: "secret",
        });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn() });
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));
        const mutationId = rig.applyHappyCloudCommand({
            action: "set_enrollment",
            state: "enrolled",
        });
        await vi.waitFor(() => expect(rejected).toHaveBeenCalledTimes(1));
        expect(attempts).toHaveLength(9);
        expect(attempts.map((attempt) => attempt.expectedVersion)).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        expect(new Set(attempts.map((attempt) => attempt.mutationId))).toEqual(
            new Set([mutationId]),
        );
        cloud.close();
        rig.close();
    });

    it("does not open the live stream for a mutation-only consumer", async () => {
        let liveRequests = 0;
        let commandRequests = 0;
        const enrolled = {
            ...status,
            enrollment: { changedAt: 1, state: "enrolled" as const },
            updatedAt: 1,
            version: 1,
        };
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                liveRequests += 1;
                return Response.json({});
            }
            if (path.endsWith("/status")) return Response.json(status);
            commandRequests += 1;
            return Response.json({ status: enrolled });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        rig.applyHappyCloudCommand({ action: "set_enrollment", state: "enrolled" });
        await vi.waitFor(() => expect(commandRequests).toBe(1));
        expect(liveRequests).toBe(0);
        rig.close();
    });

    it("keeps an invalid event local and reports the bounded stale-snapshot ceiling", async () => {
        const encoder = new TextEncoder();
        let streamController!: ReadableStreamDefaultController<Uint8Array>;
        let liveRequests = 0;
        let statusReads = 0;
        let waits = 0;
        const onError = vi.fn();
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                liveRequests += 1;
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streamController = controller;
                            controller.enqueue(
                                encoder.encode(
                                    `event: hello\ndata: ${JSON.stringify({
                                        cursor: "stale-0",
                                        gap: false,
                                        protocolVersion: 15,
                                        resumed: false,
                                    })}\n\n`,
                                ),
                            );
                            init?.signal?.addEventListener("abort", () => controller.close(), {
                                once: true,
                            });
                        },
                    }),
                );
            }
            statusReads += 1;
            return Response.json(status);
        });
        const wait = async (_ms: number, signal: AbortSignal): Promise<void> => {
            waits += 1;
            if (waits < 8) return;
            await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
            );
        };
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
            wait,
        });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn(), onError });
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));

        streamController.enqueue(
            encoder.encode(
                `id: invalid-1\nevent: update\ndata: ${JSON.stringify({
                    cursor: "invalid-1",
                    event: {
                        createdAt: 1,
                        data: { mutationId: "invalid", version: "not-a-version" },
                        id: "invalid-event-1",
                        type: "happy_cloud_changed",
                    },
                })}\n\n`,
            ),
        );
        await vi.waitFor(() => expect(statusReads).toBe(2));
        expect(liveRequests).toBe(1);

        streamController.enqueue(
            encoder.encode(
                `id: stale-1\nevent: update\ndata: ${JSON.stringify({
                    cursor: "stale-1",
                    event: {
                        createdAt: 2,
                        data: { mutationId: "future", version: 99 },
                        id: "stale-event-1",
                        type: "happy_cloud_changed",
                    },
                })}\n\n`,
            ),
        );
        await vi.waitFor(() =>
            expect(onError).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: "Happy Cloud status did not reach the version announced by Rig.",
                }),
            ),
        );
        expect(statusReads).toBe(10);
        expect(cloud.status()).toEqual(status);
        cloud.close();
        rig.close();
    });

    it("aborts an unused bootstrap without reporting close as an error", async () => {
        let statusAborted = false;
        const onError = vi.fn();
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") return liveResponse(init?.signal);
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    "abort",
                    () => {
                        statusAborted = true;
                        reject(new DOMException("aborted", "AbortError"));
                    },
                    { once: true },
                );
            });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn(), onError });
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        cloud.close();
        expect(cloud.status()).toBeUndefined();
        await vi.waitFor(() => expect(statusAborted).toBe(true));
        expect(onError).not.toHaveBeenCalled();
        rig.close();
    });

    it("reports and recovers from a non-retryable bootstrap refusal", async () => {
        const onError = vi.fn();
        let refused = false;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            if (new URL(String(input)).pathname === "/events/live") {
                return liveResponse(init?.signal);
            }
            if (!refused) {
                refused = true;
                return Response.json({ error: "Unauthorized" }, { status: 401 });
            }
            return Response.json(status);
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
            wait: async () => undefined,
        });
        const cloud = rig.connectHappyCloud({ onChange: vi.fn(), onError });
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(cloud.status()).toEqual(status));
        cloud.close();
        rig.close();
    });

    it("returns missing ciphertext as absent and rejects malformed status", async () => {
        const missing = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input, init) =>
                new URL(String(input)).pathname === "/events/live"
                    ? liveResponse(init?.signal)
                    : Response.json({ error: "missing" }, { status: 404 }),
            token: "secret",
        });
        await expect(missing.getHappyCloudProfile()).resolves.toBeUndefined();
        missing.close();

        const malformed = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input, init) =>
                new URL(String(input)).pathname === "/events/live"
                    ? liveResponse(init?.signal)
                    : Response.json({ enrolled: true, remoteControl: true }),
            token: "secret",
        });
        await expect(malformed.getHappyCloudStatus()).rejects.toThrow(
            "Rig returned an invalid Happy Cloud response.",
        );
        malformed.close();
    });
});

function liveResponse(signal: AbortSignal | null | undefined): Response {
    const encoder = new TextEncoder();
    let open = true;
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        `event: hello\ndata: ${JSON.stringify({
                            cursor: "cloud-cursor",
                            gap: false,
                            protocolVersion: 15,
                            resumed: false,
                        })}\n\n`,
                    ),
                );
                signal?.addEventListener(
                    "abort",
                    () => {
                        if (!open) return;
                        open = false;
                        controller.close();
                    },
                    { once: true },
                );
            },
        }),
        { headers: { "content-type": "text/event-stream" } },
    );
}
