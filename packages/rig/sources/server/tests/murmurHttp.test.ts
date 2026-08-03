import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import type { MurmurServiceContract } from "../../murmur/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const profile = { firstName: "Ada", lastName: "Lovelace" };
const account = { id: "ada", profile, token: "ada-token" };
const stopped = { relayUrls: [], status: "stopped" as const };
const contact = {
    addedAt: 1,
    id: "grace",
    profile: { firstName: "Grace", lastName: "Hopper" },
    token: "grace-token",
    updatedAt: 2,
};
const friendRequest = {
    id: "request-1",
    profile: contact.profile,
    receivedAt: 1,
    senderId: contact.id,
    senderToken: contact.token,
};
const stats = {
    acceptedRequests: 1,
    autoAcceptedRequests: 0,
    contacts: 1,
    incomingPending: 0,
    outgoingPending: 0,
    rejectedRequests: 0,
};
const friendship = {
    answeredAt: 2,
    autoAcceptEligible: false,
    direction: "mutual" as const,
    firstSeenAt: 1,
    history: { accepted: 1, autoAccepted: 0, received: 1, rejected: 0, sent: 0 },
    peerId: contact.id,
    profile: contact.profile,
    requestId: "request-1",
    state: "friends" as const,
    token: contact.token,
    updatedAt: 2,
    version: "018bcfe5-6800-7fff-a5aa-0102030405ff",
};

describe("Murmur HTTP API", () => {
    it("routes account, service, friend-request, and contact methods without exposing keys", async () => {
        const murmur = createMurmurStub();
        const server = await startServer(murmur);
        try {
            await expect(server.client.getMurmurAccount()).resolves.toEqual({
                account,
                service: stopped,
            });
            await expect(
                server.client.signupMurmurAccount({
                    firstName: "Ada",
                    lastName: "Lovelace",
                }),
            ).resolves.toEqual({ account, service: stopped });
            await expect(
                server.client.startMurmurService({
                    relayUrls: ["https://murmur.cluster-fluster.com/"],
                }),
            ).resolves.toMatchObject({ service: { status: "running" } });
            await server.client.stopMurmurService();
            await expect(
                server.client.sendMurmurFriendRequest({ token: "grace-token" }),
            ).resolves.toEqual({
                friendship,
                queued: true,
                recipientId: "grace",
                stats,
            });
            await expect(server.client.listMurmurFriendRequests()).resolves.toEqual({
                requests: [friendRequest],
            });
            await expect(
                server.client.answerMurmurFriendRequest("request/1", { answer: "accept" }),
            ).resolves.toEqual({ answer: "accept", contact, friendship, stats });
            await expect(server.client.getMurmurFriends()).resolves.toEqual({
                account,
                contacts: [contact],
                friendships: [friendship],
                service: stopped,
                stats,
            });
            await expect(server.client.listMurmurContacts()).resolves.toEqual({
                contacts: [contact],
            });
            await expect(server.client.deleteMurmurAccount()).resolves.toEqual({
                deleted: true,
            });

            expect(murmur.signup).toHaveBeenCalledWith({
                firstName: "Ada",
                lastName: "Lovelace",
            });
            expect(murmur.start).toHaveBeenCalledWith({
                relayUrls: ["https://murmur.cluster-fluster.com/"],
            });
            expect(murmur.answerFriendRequest).toHaveBeenCalledWith("request/1", {
                answer: "accept",
            });
            expect(JSON.stringify(await server.client.getMurmurAccount())).not.toMatch(
                /secretKey/u,
            );
        } finally {
            await server.close();
        }
    });

    it("rejects malformed signup bodies before calling the service", async () => {
        const murmur = createMurmurStub();
        const server = await startServer(murmur);
        try {
            const response = await requestJson(server.socketPath, "/murmur/account", {
                firstName: "Ada",
                lastName: "Lovelace",
                signingSecretKey: "must-not-pass",
            });

            expect(response.status).toBe(400);
            expect(murmur.signup).not.toHaveBeenCalled();
        } finally {
            await server.close();
        }
    });

    it("lets Murmur database failures reach the daemon crash boundary", async () => {
        const murmur = createMurmurStub();
        const databaseError = Object.assign(new Error("Murmur database failed"), {
            code: "SQLITE_IOERR",
        });
        vi.mocked(murmur.getAccount).mockRejectedValue(databaseError);
        const server = await startServer(murmur);
        const request = httpRequest({
            headers: { authorization: "Bearer secret" },
            method: "GET",
            path: "/murmur/account",
            socketPath: server.socketPath,
        });
        let responseReceived = false;
        request.once("response", () => {
            responseReceived = true;
        });
        request.on("error", () => {});

        try {
            const escaped = await captureUnhandledRejection(async () => {
                request.end();
            });
            expect(escaped).toBe(databaseError);
            expect(responseReceived).toBe(false);
        } finally {
            request.destroy();
            await server.close();
        }
    });
});

function createMurmurStub(): MurmurServiceContract & {
    answerFriendRequest: ReturnType<typeof vi.fn<MurmurServiceContract["answerFriendRequest"]>>;
    signup: ReturnType<typeof vi.fn<MurmurServiceContract["signup"]>>;
    start: ReturnType<typeof vi.fn<MurmurServiceContract["start"]>>;
} {
    return {
        answerFriendRequest: vi.fn(async (_id, request) => ({
            answer: request.answer,
            ...(request.answer === "accept" ? { contact } : {}),
            friendship,
            stats,
        })),
        close: vi.fn(async () => undefined),
        deleteAccount: vi.fn(async () => ({ deleted: true })),
        getAccount: vi.fn(async () => ({ account, service: stopped })),
        getFriends: vi.fn(async () => ({
            account,
            contacts: [contact],
            friendships: [friendship],
            service: stopped,
            stats,
        })),
        listContacts: vi.fn(async () => ({ contacts: [contact] })),
        listFriendRequests: vi.fn(async () => ({ requests: [friendRequest] })),
        sendFriendRequest: vi.fn(async () => ({
            friendship,
            queued: true,
            recipientId: "grace",
            stats,
        })),
        signup: vi.fn(async (_request) => ({ account, service: stopped })),
        start: vi.fn(async (request = {}) => ({
            service: {
                relayUrls: request.relayUrls ?? ["https://murmur.cluster-fluster.com/"],
                status: "running",
            },
        })),
        stop: vi.fn(async () => ({ service: stopped })),
    };
}

async function startServer(murmur: MurmurServiceContract): Promise<{
    client: ProtocolHttpClient;
    close(): Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = join(directory, "server.sock");
    const server = createProtocolHttpServer({ murmur, token: "secret" });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        client: new ProtocolHttpClient({ socketPath, token: "secret" }),
        socketPath,
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { force: true, recursive: true });
        },
    };
}

async function requestJson(
    socketPath: string,
    path: string,
    body: unknown,
): Promise<{ body: unknown; status: number }> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                headers: {
                    authorization: "Bearer secret",
                    "content-length": Buffer.byteLength(payload),
                    "content-type": "application/json",
                },
                method: "POST",
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
                        status: response.statusCode ?? 500,
                    });
                });
            },
        );
        request.on("error", reject);
        request.end(payload);
    });
}

async function captureUnhandledRejection(run: () => Promise<void>): Promise<unknown> {
    const installed = process.listeners("unhandledRejection");
    for (const listener of installed) process.off("unhandledRejection", listener);
    let captured: unknown;
    const observe = (reason: unknown): void => {
        captured ??= reason;
    };
    process.on("unhandledRejection", observe);
    try {
        await run();
        for (let attempt = 0; attempt < 200 && captured === undefined; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return captured;
    } finally {
        process.off("unhandledRejection", observe);
        for (const listener of installed) process.on("unhandledRejection", listener);
    }
}
