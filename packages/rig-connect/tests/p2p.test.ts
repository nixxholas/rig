import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/index.js";

describe("P2P status subscription", () => {
    it("loads the endpoint identity and applies live peer health updates", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const initial = {
            transports: [
                {
                    localId: "local-endpoint",
                    peers: [{ peerId: "remote-endpoint", status: "connecting" as const }],
                    state: "ready" as const,
                    transport: "iroh" as const,
                },
            ],
        };
        const connected = {
            transports: [
                {
                    localId: "local-endpoint",
                    peers: [
                        {
                            lastSeenAt: 123,
                            peerId: "remote-endpoint",
                            rttMs: 8,
                            status: "connected" as const,
                        },
                    ],
                    state: "ready" as const,
                    transport: "iroh" as const,
                },
            ],
        };
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = String(input);
            if (url.endsWith("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            if (url.endsWith("/p2p/status")) return Response.json(initial);
            return new Response("not found", { status: 404 });
        });
        const changed = vi.fn();
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectP2p({ onChange: changed });

        await vi.waitFor(() => expect(connection.status()).toEqual(initial));
        stream.enqueue(
            encoder.encode(
                sse("event", {
                    cursor: "01900000-0000-7000-8000-000000000001",
                    event: {
                        createdAt: 123,
                        data: { status: connected },
                        id: "01900000-0000-7000-8000-000000000001",
                        type: "p2p_status_changed",
                    },
                }),
            ),
        );
        await vi.waitFor(() => expect(connection.status()).toEqual(connected));
        expect(changed).toHaveBeenLastCalledWith(connected);

        connection.close();
        rig.close();
        stream.close();
    });

    it("does not let an older opening snapshot overwrite a live status update", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let resolveSnapshot!: (response: Response) => void;
        const snapshot = {
            transports: [
                {
                    localId: "local-endpoint",
                    peers: [{ peerId: "remote-endpoint", status: "connecting" as const }],
                    state: "ready" as const,
                    transport: "iroh" as const,
                },
            ],
        };
        const live = {
            transports: [
                {
                    localId: "local-endpoint",
                    peers: [{ peerId: "remote-endpoint", rttMs: 5, status: "connected" as const }],
                    state: "ready" as const,
                    transport: "iroh" as const,
                },
            ],
        };
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input) => {
                if (String(input).endsWith("/events/live")) {
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                stream = controller;
                            },
                        }),
                    );
                }
                return new Promise<Response>((resolve) => {
                    resolveSnapshot = resolve;
                });
            },
            token: "secret",
        });
        const connection = rig.connectP2p({ onChange: () => undefined });
        stream.enqueue(
            encoder.encode(
                sse("hello", {
                    cursor: "01900000-0000-7000-8000-000000000000",
                    gap: false,
                    protocolVersion: 6,
                    resumed: false,
                }),
            ),
        );
        stream.enqueue(
            encoder.encode(
                sse("event", {
                    cursor: "01900000-0000-7000-8000-000000000001",
                    event: {
                        createdAt: 123,
                        data: { status: live },
                        id: "01900000-0000-7000-8000-000000000001",
                        type: "p2p_status_changed",
                    },
                }),
            ),
        );
        await vi.waitFor(() => expect(resolveSnapshot).toBeTypeOf("function"));
        resolveSnapshot(Response.json(snapshot));

        await vi.waitFor(() => expect(connection.status()).toEqual(live));
        connection.close();
        rig.close();
        stream.close();
    });

    it("does not report a failed opening snapshot after a newer live status arrives", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let resolveSnapshot!: (response: Response) => void;
        const onError = vi.fn();
        const live = {
            transports: [
                {
                    localId: "local-endpoint",
                    peers: [{ peerId: "remote-endpoint", status: "connected" as const }],
                    state: "ready" as const,
                    transport: "iroh" as const,
                },
            ],
        };
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input) => {
                if (String(input).endsWith("/events/live")) {
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                stream = controller;
                            },
                        }),
                    );
                }
                return new Promise<Response>((resolve) => {
                    resolveSnapshot = resolve;
                });
            },
            token: "secret",
        });
        const connection = rig.connectP2p({ onChange: () => undefined, onError });
        stream.enqueue(
            encoder.encode(
                sse("event", {
                    cursor: "01900000-0000-7000-8000-000000000001",
                    event: {
                        createdAt: 123,
                        data: { status: live },
                        id: "01900000-0000-7000-8000-000000000001",
                        type: "p2p_status_changed",
                    },
                }),
            ),
        );
        await vi.waitFor(() => expect(connection.status()).toEqual(live));
        resolveSnapshot(new Response("starting", { status: 503 }));

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(onError).not.toHaveBeenCalled();
        expect(connection.status()).toEqual(live);
        connection.close();
        rig.close();
        stream.close();
    });

    it("retries a failed opening load while the subscription remains active", async () => {
        let reads = 0;
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const onError = vi.fn();
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input) => {
                if (String(input).endsWith("/events/live")) {
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                stream = controller;
                            },
                        }),
                    );
                }
                reads += 1;
                return reads === 1
                    ? new Response("starting", { status: 503 })
                    : Response.json({ transports: [] });
            },
            token: "secret",
            wait: async () => undefined,
        });
        const connection = rig.connectP2p({ onChange: () => undefined, onError });

        await vi.waitFor(() => expect(connection.status()).toEqual({ transports: [] }));
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(onError).toHaveBeenCalledOnce();
        connection.close();
        rig.close();
        stream.close();
    });

    it("refetches ephemeral status after a clean stream resume", async () => {
        const encoder = new TextEncoder();
        const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
        let reads = 0;
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input) => {
                if (String(input).includes("/events/live")) {
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                streams.push(controller);
                            },
                        }),
                    );
                }
                reads += 1;
                return Response.json({
                    transports: [
                        {
                            localId: "local-endpoint",
                            peers: [
                                {
                                    peerId: "remote-endpoint",
                                    status: reads === 1 ? "connecting" : "connected",
                                },
                            ],
                            state: "ready",
                            transport: "iroh",
                        },
                    ],
                });
            },
            token: "secret",
            wait: async () => undefined,
        });
        const connection = rig.connectP2p({ onChange: () => undefined });
        await vi.waitFor(() =>
            expect(connection.status()).toMatchObject({
                transports: [{ peers: [{ status: "connecting" }] }],
            }),
        );

        streams[0]!.close();
        await vi.waitFor(() => expect(streams).toHaveLength(2));
        streams[1]!.enqueue(
            encoder.encode(
                sse("hello", {
                    cursor: "01900000-0000-7000-8000-000000000001",
                    gap: false,
                    protocolVersion: 6,
                    resumed: true,
                }),
            ),
        );
        await vi.waitFor(() =>
            expect(connection.status()).toMatchObject({
                transports: [{ peers: [{ status: "connected" }] }],
            }),
        );
        expect(reads).toBeGreaterThanOrEqual(2);
        connection.close();
        rig.close();
        streams[1]!.close();
    });
});

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
