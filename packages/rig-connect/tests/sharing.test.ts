import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/index.js";
import type { SharingSnapshot } from "@/protocol.js";

const IDENTITY = "A".repeat(43);
const REMOTE = "B".repeat(43);
const PROFILE = {
    createdAt: 1,
    email: "steve@example.test",
    id: "aprofile000000000000000001",
    name: "Steve",
    parentInstanceId: "aparent0000000000000000001",
    updatedAt: 1,
    version: 1,
};

function sharing(version: string, contacts = 0): SharingSnapshot {
    return {
        connection: "connected",
        contacts: Array.from({ length: contacts }, () => ({
            identity: REMOTE,
            profile: null,
            status: "active" as const,
        })),
        identity: IDENTITY,
        incomingRequests: [],
        outgoingRequests: [],
        profileId: "aprofile000000000000000001",
        version,
    };
}

describe("Sharing connection", () => {
    it("loads contacts and refetches them from the one global event stream", async () => {
        const encoder = new TextEncoder();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let reads = 0;
        const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === "/events/live") {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        },
                    }),
                );
            }
            if (path === "/sharing") {
                reads += 1;
                return Response.json(
                    reads === 1
                        ? sharing("01900000-0000-7000-8000-000000000001")
                        : sharing("01900000-0000-7000-8000-000000000002", 1),
                );
            }
            return new Response("not found", { status: 404 });
        });
        const changed = vi.fn();
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch,
            token: "secret",
        });
        const connection = rig.connectSharing({ onChange: changed });
        stream.enqueue(
            encoder.encode(
                sse("hello", {
                    cursor: "01900000-0000-7000-8000-000000000001",
                    gap: false,
                    protocolVersion: 17,
                    resumed: false,
                }),
            ),
        );
        await vi.waitFor(() =>
            expect(connection.snapshot()).toEqual(sharing("01900000-0000-7000-8000-000000000001")),
        );

        stream.enqueue(
            encoder.encode(
                sse("event", {
                    cursor: "01900000-0000-7000-8000-000000000002",
                    event: {
                        createdAt: 2,
                        data: { version: "01900000-0000-7000-8000-000000000002" },
                        id: "01900000-0000-7000-8000-000000000002",
                        type: "sharing_changed",
                    },
                }),
            ),
        );
        await vi.waitFor(() => expect(connection.snapshot()?.contacts).toHaveLength(1));
        expect(changed).toHaveBeenLastCalledWith(
            sharing("01900000-0000-7000-8000-000000000002", 1),
        );

        connection.close();
        rig.close();
        stream.close();
    });

    it("calls every contact-management endpoint and validates its responses", async () => {
        const current = sharing("01900000-0000-7000-8000-000000000003");
        const requests: { body: unknown; method: string | undefined; path: string }[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const path = new URL(String(input)).pathname;
            requests.push({
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
                method: init?.method,
                path,
            });
            if (path === "/sharing/invitations") {
                return Response.json({ expiresAt: 301_000, invitation: IDENTITY });
            }
            if (path === "/onboarding/murmur") {
                return Response.json({ enabled: true, profile: PROFILE, publicKey: IDENTITY });
            }
            if (path === "/sharing/contact-requests" && init?.method === "POST") {
                return Response.json({
                    request: { id: IDENTITY, identity: REMOTE, sessionId: IDENTITY },
                });
            }
            return Response.json(current);
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });

        await expect(rig.onboardMurmur({ enabled: true, profileId: PROFILE.id })).resolves.toEqual({
            enabled: true,
            profile: PROFILE,
            publicKey: IDENTITY,
        });
        await expect(rig.createSharingInvitation()).resolves.toEqual({
            expiresAt: 301_000,
            invitation: IDENTITY,
        });
        await expect(rig.requestSharingContact(IDENTITY)).resolves.toEqual({
            id: IDENTITY,
            identity: REMOTE,
            sessionId: IDENTITY,
        });
        await expect(rig.acceptSharingContactRequest("request-1")).resolves.toEqual(current);
        await expect(rig.rejectSharingContactRequest("request-2")).resolves.toEqual(current);
        await expect(rig.removeSharingContact(REMOTE)).resolves.toEqual(current);

        expect(requests).toEqual([
            {
                body: { enabled: true, profileId: PROFILE.id },
                method: "PUT",
                path: "/onboarding/murmur",
            },
            { body: undefined, method: "POST", path: "/sharing/invitations" },
            {
                body: { invitation: IDENTITY },
                method: "POST",
                path: "/sharing/contact-requests",
            },
            {
                body: undefined,
                method: "POST",
                path: "/sharing/contact-requests/request-1/accept",
            },
            {
                body: undefined,
                method: "DELETE",
                path: "/sharing/contact-requests/request-2",
            },
            {
                body: undefined,
                method: "DELETE",
                path: `/sharing/contacts/${REMOTE}`,
            },
        ]);
        rig.close();
    });
});

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
