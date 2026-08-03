import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/index.js";

const profile = {
    firstName: "Ada",
    lastName: "Lovelace",
    photo: {
        bytes: 3,
        data: "AQID",
        height: 1,
        mediaType: "image/webp" as const,
        thumbhash: "AQID",
        width: 1,
    },
};
const account = { id: "ada", profile, token: "ada-token" };
const stopped = { relayUrls: [], status: "stopped" as const };
const stats = {
    acceptedRequests: 0,
    autoAcceptedRequests: 0,
    contacts: 0,
    incomingPending: 0,
    outgoingPending: 1,
    rejectedRequests: 0,
};
const friendship = {
    autoAcceptEligible: false,
    direction: "outgoing" as const,
    firstSeenAt: 1,
    history: { accepted: 0, autoAccepted: 0, received: 0, rejected: 0, sent: 1 },
    peerId: "grace",
    profile: { firstName: "Grace", lastName: "Hopper" },
    requestId: "request-1",
    state: "outgoing_pending" as const,
    token: "grace-token",
    updatedAt: 1,
    version: "v1",
};

describe("Murmur API", () => {
    it("exposes account, service, friend-request, and contact operations", async () => {
        const requested: Array<{ body: unknown; method: string; path: string }> = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const url = new URL(String(input));
            requested.push({
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
                method: init?.method ?? "GET",
                path: url.pathname,
            });
            const responses: Record<string, unknown> = {
                "DELETE /murmur/account": { deleted: true },
                "GET /murmur/account": { account, service: stopped },
                "GET /murmur/contacts": {
                    contacts: [
                        {
                            addedAt: 1,
                            id: "grace",
                            profile: { firstName: "Grace", lastName: "Hopper" },
                            token: "grace-token",
                            updatedAt: 2,
                        },
                    ],
                },
                "GET /murmur/friend-requests": {
                    requests: [
                        {
                            id: "request-1",
                            profile: { firstName: "Grace", lastName: "Hopper" },
                            receivedAt: 1,
                            senderId: "grace",
                            senderToken: "grace-token",
                        },
                    ],
                },
                "GET /murmur/friends": {
                    account,
                    contacts: [],
                    friendships: [friendship],
                    service: stopped,
                    stats,
                },
                "POST /murmur/account": { account, service: stopped },
                "POST /murmur/friend-requests": {
                    friendship,
                    queued: true,
                    recipientId: "grace",
                    stats,
                },
                "POST /murmur/friend-requests/request-1/answer": {
                    answer: "accept",
                    contact: {
                        addedAt: 1,
                        id: "grace",
                        profile: { firstName: "Grace", lastName: "Hopper" },
                        token: "grace-token",
                        updatedAt: 1,
                    },
                    friendship: {
                        ...friendship,
                        requestId: undefined,
                        state: "friends",
                        updatedAt: 2,
                        version: "v2",
                    },
                    stats: {
                        ...stats,
                        acceptedRequests: 1,
                        contacts: 1,
                        outgoingPending: 0,
                    },
                },
                "POST /murmur/service/start": {
                    service: {
                        relayUrls: ["https://relay.example"],
                        status: "running",
                    },
                },
                "POST /murmur/service/stop": { service: stopped },
            };
            return Response.json(responses[`${init?.method ?? "GET"} ${url.pathname}`]);
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });

        await expect(rig.getMurmurAccount()).resolves.toEqual({ account, service: stopped });
        await expect(
            rig.signupMurmurAccount({ firstName: "Ada", lastName: "Lovelace" }),
        ).resolves.toEqual({ account, service: stopped });
        await expect(
            rig.startMurmurService({ relayUrls: ["https://relay.example"] }),
        ).resolves.toMatchObject({ service: { status: "running" } });
        await expect(rig.stopMurmurService()).resolves.toEqual({ service: stopped });
        await expect(rig.sendMurmurFriendRequest("grace-token")).resolves.toMatchObject({
            friendship: { peerId: "grace" },
            recipientId: "grace",
        });
        await expect(rig.listMurmurFriendRequests()).resolves.toMatchObject({
            requests: [{ id: "request-1" }],
        });
        await expect(rig.answerMurmurFriendRequest("request-1", "accept")).resolves.toMatchObject({
            answer: "accept",
            contact: { id: "grace" },
        });
        await expect(rig.listMurmurContacts()).resolves.toMatchObject({
            contacts: [{ id: "grace" }],
        });
        await expect(rig.listMurmurFriends()).resolves.toMatchObject({
            friendships: [{ peerId: "grace" }],
            stats,
        });
        await expect(rig.deleteMurmurAccount()).resolves.toEqual({ deleted: true });

        expect(requested).toContainEqual({
            body: { token: "grace-token" },
            method: "POST",
            path: "/murmur/friend-requests",
        });
        expect(requested).toContainEqual({
            body: { answer: "accept" },
            method: "POST",
            path: "/murmur/friend-requests/request-1/answer",
        });
        rig.close();
    });

    it("rejects malformed daemon responses", async () => {
        const rig = connectRig({
            endpoint: "http://rig.test",
            fetch: async () => Response.json({ account: { secretKeys: "leaked" } }),
            token: "secret",
        });

        await expect(rig.getMurmurAccount()).rejects.toThrow(
            "Rig returned an invalid Murmur response.",
        );
        rig.close();
    });
});
