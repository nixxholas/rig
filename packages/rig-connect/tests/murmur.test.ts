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
                "POST /murmur/account": { account, service: stopped },
                "POST /murmur/friend-requests": { recipientId: "grace" },
                "POST /murmur/friend-requests/request-1/answer": {
                    answer: "accept",
                    contact: {
                        addedAt: 1,
                        id: "grace",
                        profile: { firstName: "Grace", lastName: "Hopper" },
                        token: "grace-token",
                        updatedAt: 1,
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
        await expect(rig.sendMurmurFriendRequest("grace-token")).resolves.toEqual({
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
