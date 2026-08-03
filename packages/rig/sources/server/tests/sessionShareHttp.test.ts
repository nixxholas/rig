import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SessionShareServiceContract } from "../../session-sharing/index.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const grant = {
    grantEpoch: 1,
    murmurPeerId: "peer-friend",
    shareId: "share-1",
    shareMemberId: "member-1",
};
const member = {
    createdAt: 1,
    currentGrantEpoch: 1,
    displayName: "Friend",
    murmurPeerId: "peer-friend",
    shareId: "share-1",
    shareMemberId: "member-1",
    state: "active" as const,
    updatedAt: 1,
};
const owner = {
    members: [member],
    share: {
        includeFriendMessagesInModel: true,
        memberCount: 1,
        shareId: "share-1",
        state: "active" as const,
    },
};
const replica = {
    createdAt: 1,
    grant,
    memberCount: 1,
    ownerPeerId: "peer-owner",
    state: "active" as const,
    title: "Shared session",
    updatedAt: 1,
};

describe("session share HTTP API", () => {
    it("keeps the runtime gated when the real transport-backed service is absent", async () => {
        const server = await startServer();
        try {
            const response = await request(server.socketPath, "GET", "/sessions/session-1/share");
            expect(response).toMatchObject({
                status: 503,
                body: {
                    error: expect.stringContaining("Murmur transport"),
                },
            });
        } finally {
            await server.close();
        }
    });

    it("validates and routes owner, member, replica, health, and friend-post operations", async () => {
        const service = createStub();
        const server = await startServer(service);
        try {
            expect(
                await request(server.socketPath, "POST", "/sessions/session-1/share", {
                    friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                    includeFriendMessagesInModel: true,
                    mutationId: "mutation-1",
                }),
            ).toMatchObject({ body: owner, status: 201 });
            await request(server.socketPath, "POST", "/sessions/session-1/share/members", {
                friend: { displayName: "Second", peerId: "peer-second" },
                mutationId: "mutation-2",
            });
            await request(
                server.socketPath,
                "POST",
                "/sessions/session-1/share/members/member%2F1/revoke",
                { mutationId: "mutation-3" },
            );
            await request(server.socketPath, "POST", "/sessions/session-1/share/friend-messages", {
                includeFriendMessagesInModel: false,
                mutationId: "mutation-4",
            });
            await request(server.socketPath, "POST", "/sessions/session-1/share/stop", {
                mutationId: "mutation-5",
            });
            expect(
                await request(server.socketPath, "POST", "/session-shares/friend-messages", {
                    clientMessageId: "client-1",
                    grant,
                    text: "Hello",
                }),
            ).toMatchObject({
                body: { accepted: true, clientMessageId: "client-1" },
                status: 202,
            });
            expect(
                await request(server.socketPath, "GET", "/session-share-replicas"),
            ).toMatchObject({ body: { replicas: [replica] }, status: 200 });
            expect(
                await request(
                    server.socketPath,
                    "GET",
                    "/session-share-replicas/share-1/history?after=event-0",
                ),
            ).toMatchObject({
                body: expect.objectContaining({ complete: true, replica }),
                status: 200,
            });
            expect(
                await request(server.socketPath, "GET", "/session-shares/share-1/health"),
            ).toMatchObject({
                body: { health: expect.objectContaining({ state: "active" }) },
                status: 200,
            });

            expect(service.create).toHaveBeenCalledWith(
                "session-1",
                expect.objectContaining({ mutationId: "mutation-1" }),
            );
            expect(service.revoke).toHaveBeenCalledWith("session-1", "member/1", {
                mutationId: "mutation-3",
            });
            expect(service.replicaHistory).toHaveBeenCalledWith("share-1", "event-0");
        } finally {
            await server.close();
        }
    });

    it("rejects extra fields before they reach the sharing boundary", async () => {
        const service = createStub();
        const server = await startServer(service);
        try {
            const response = await request(server.socketPath, "POST", "/sessions/session-1/share", {
                friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                includeFriendMessagesInModel: true,
                mutationId: "mutation-1",
                ownerPeerId: "forged-owner",
            });
            expect(response.status).toBe(400);
            expect(service.create).not.toHaveBeenCalled();
        } finally {
            await server.close();
        }
    });
});

function createStub(): SessionShareServiceContract & {
    create: ReturnType<typeof vi.fn<SessionShareServiceContract["create"]>>;
    replicaHistory: ReturnType<typeof vi.fn<SessionShareServiceContract["replicaHistory"]>>;
    revoke: ReturnType<typeof vi.fn<SessionShareServiceContract["revoke"]>>;
} {
    const create = vi.fn<SessionShareServiceContract["create"]>(async () => owner);
    const replicaHistory = vi.fn<SessionShareServiceContract["replicaHistory"]>(() => ({
        complete: true,
        entries: [],
        replica,
    }));
    const revoke = vi.fn<SessionShareServiceContract["revoke"]>(async () => owner);
    return {
        add: vi.fn<SessionShareServiceContract["add"]>(async () => owner),
        create,
        getOwner: vi.fn<SessionShareServiceContract["getOwner"]>(() => owner),
        health: vi.fn<SessionShareServiceContract["health"]>(() => ({
            health: {
                checkedAt: 1,
                pendingBytes: 0,
                pendingEntries: 0,
                state: "active" as const,
            },
        })),
        listReplicas: vi.fn<SessionShareServiceContract["listReplicas"]>(() => ({
            replicas: [replica],
        })),
        postFriendMessage: vi.fn<SessionShareServiceContract["postFriendMessage"]>(
            async (post) => ({
                accepted: true,
                clientMessageId: post.clientMessageId,
            }),
        ),
        replicaHistory,
        revoke,
        setFriendMessages: vi.fn<SessionShareServiceContract["setFriendMessages"]>(
            async () => owner,
        ),
        stop: vi.fn<SessionShareServiceContract["stop"]>(async () => ({
            ...owner,
            share: { ...owner.share, state: "stopped" as const },
        })),
    };
}

async function startServer(sessionShares?: SessionShareServiceContract): Promise<{
    close(): Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = join(directory, "server.sock");
    const server = createProtocolHttpServer({
        ...(sessionShares === undefined ? {} : { sessionShares }),
        token: "secret",
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        socketPath,
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { force: true, recursive: true });
        },
    };
}

async function request(
    socketPath: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
): Promise<{ body: unknown; status: number }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const outgoing = httpRequest(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(payload === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(payload),
                              "content-type": "application/json",
                          }),
                },
                method,
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
        outgoing.on("error", reject);
        outgoing.end(payload);
    });
}
