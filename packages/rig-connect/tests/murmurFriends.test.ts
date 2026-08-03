import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/index.js";

const CURSOR_1 = "01900000-0000-7000-8000-000000000001";
const CURSOR_2 = "01900000-0000-7000-8000-000000000002";
const CURSOR_3 = "01900000-0000-7000-8000-000000000003";

describe("Murmur friends subscription", () => {
    it("bootstraps once, refetches unique friendship events, and keeps unchanged references", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let reads = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = String(input);
            if (url.includes("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            if (url.endsWith("/murmur/friends")) {
                reads += 1;
                return Response.json(snapshot(reads === 3 ? "friends" : "outgoing_pending"));
            }
            return new Response("not found", { status: 404 });
        });
        const changed = vi.fn();
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });
        const connection = rig.connectMurmurFriends({ onChange: changed });

        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(reads).toBe(1));
        const first = connection.friendships()[0]!;
        expect(connection.state()).toMatchObject({
            connection: "live",
            stats: { outgoingPending: 1 },
        });

        stream.enqueue(encoder.encode(friendshipChanged(CURSOR_2, "friend-event-1")));
        await vi.waitFor(() => expect(reads).toBe(2));
        expect(connection.friendships()[0]).toBe(first);

        stream.enqueue(encoder.encode(friendshipChanged(CURSOR_2, "friend-event-1")));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(reads).toBe(2);

        stream.enqueue(encoder.encode(friendshipChanged(CURSOR_3, "friend-event-2")));
        await vi.waitFor(() => expect(reads).toBe(3));
        expect(connection.friendships()[0]).not.toBe(first);
        expect(connection.state()).toMatchObject({
            connection: "live",
            stats: { acceptedRequests: 1, outgoingPending: 0 },
        });
        expect(changed).toHaveBeenCalled();

        connection.close();
        rig.close();
        stream.close();
    });

    it("does not reload after a clean resume but rebuilds after a stream gap", async () => {
        const encoder = new TextEncoder();
        const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
        let reads = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const url = String(input);
            if (url.includes("/events/live")) {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streams.push(controller);
                        },
                    }),
                );
            }
            if (url.endsWith("/murmur/friends")) {
                reads += 1;
                return Response.json(snapshot(reads === 1 ? "outgoing_pending" : "friends"));
            }
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
            wait: async () => undefined,
        });
        const connection = rig.connectMurmurFriends({ onChange: () => undefined });

        await vi.waitFor(() => expect(streams).toHaveLength(1));
        streams[0]!.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(reads).toBe(1));

        streams[0]!.close();
        await vi.waitFor(() => expect(streams).toHaveLength(2));
        streams[1]!.enqueue(encoder.encode(hello(CURSOR_2, false, true)));
        await vi.waitFor(() => expect(connection.state().connection).toBe("live"));
        expect(reads).toBe(1);

        streams[1]!.close();
        await vi.waitFor(() => expect(streams).toHaveLength(3));
        streams[2]!.enqueue(encoder.encode(hello(CURSOR_3, true, false)));
        await vi.waitFor(() => expect(reads).toBe(2));
        expect(connection.friendships()[0]).toMatchObject({ state: "friends" });
        expect(connection.state().connection).toBe("live");

        connection.close();
        rig.close();
        streams[2]!.close();
    });

    it("releases an owned opening request when the last subscriber closes", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let aborted = false;
        let openingRequestStarted = false;
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch: async (input, init) => {
                if (String(input).endsWith("/events/live")) {
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                stream = controller;
                            },
                        }),
                    );
                }
                openingRequestStarted = true;
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener(
                        "abort",
                        () => {
                            aborted = true;
                            reject(new DOMException("Aborted", "AbortError"));
                        },
                        { once: true },
                    );
                });
            },
            token: "secret",
        });
        const connection = rig.connectMurmurFriends({ onChange: () => undefined });
        stream.enqueue(encoder.encode(hello(CURSOR_1, false, false)));
        await vi.waitFor(() => expect(openingRequestStarted).toBe(true));

        connection.close();
        await vi.waitFor(() => expect(aborted).toBe(true));
        rig.close();
        stream.close();
    });
});

function snapshot(state: "friends" | "outgoing_pending") {
    const friends = state === "friends";
    return {
        account: {
            id: "ada",
            profile: { firstName: "Ada", lastName: "Lovelace" },
            token: "ada-token",
        },
        contacts: friends
            ? [
                  {
                      addedAt: 2,
                      id: "grace",
                      profile: { firstName: "Grace", lastName: "Hopper" },
                      token: "grace-token",
                      updatedAt: 2,
                  },
              ]
            : [],
        friendships: [
            {
                autoAcceptEligible: !friends,
                direction: "outgoing" as const,
                firstSeenAt: 1,
                history: {
                    accepted: friends ? 1 : 0,
                    autoAccepted: 0,
                    received: 0,
                    rejected: 0,
                    sent: 1,
                },
                peerId: "grace",
                profile: { firstName: "Grace", lastName: "Hopper" },
                requestId: friends ? undefined : "request-1",
                state,
                token: "grace-token",
                updatedAt: friends ? 2 : 1,
                version: friends ? "v2" : "v1",
            },
        ],
        service: { relayUrls: ["https://relay.example"], status: "running" as const },
        stats: {
            acceptedRequests: friends ? 1 : 0,
            autoAcceptedRequests: 0,
            contacts: friends ? 1 : 0,
            incomingPending: 0,
            outgoingPending: friends ? 0 : 1,
            rejectedRequests: 0,
        },
    };
}

function friendshipChanged(cursor: string, id: string): string {
    return sse("event", {
        cursor,
        event: {
            createdAt: 1,
            data: {
                direction: "outgoing",
                reason: "request_sent",
                state: "outgoing_pending",
            },
            id,
            murmurPeerId: "grace",
            type: "murmur_friendship_changed",
        },
    });
}

function hello(cursor: string, gap: boolean, resumed: boolean): string {
    return sse("hello", { cursor, gap, protocolVersion: 6, resumed });
}

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
