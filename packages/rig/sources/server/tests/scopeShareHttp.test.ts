import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ScopeShareServiceContract } from "../../scope-sharing/ScopeShareServiceContract.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const member = {
    createdAt: 1,
    currentGrantEpoch: 1,
    displayName: "Friend",
    murmurPeerId: "peer-friend",
    shareId: "wsp_share1",
    shareMemberId: "member-1",
    state: "active" as const,
    updatedAt: 1,
};
const owner = {
    members: [member],
    share: {
        memberCount: 1,
        scopeId: "workspace-1",
        scopeKind: "workspace" as const,
        shareId: "wsp_share1",
        state: "active" as const,
    },
};
const replica = {
    createdAt: 1,
    grant: {
        grantEpoch: 1,
        murmurPeerId: "peer-self",
        shareId: "wsp_share1",
        shareMemberId: "member-1",
    },
    memberCount: 1,
    ownerPeerId: "peer-owner",
    scopeKind: "workspace" as const,
    state: "active" as const,
    title: "scope-sharing",
    updatedAt: 1,
};

const SHARE_PATH = "/projects/project-1/workspaces/workspace-1/share";

describe("scope share HTTP API", () => {
    it("reports plainly when a server was started without workspace sharing", async () => {
        const server = await startServer();
        try {
            expect(await request(server.socketPath, "GET", SHARE_PATH)).toMatchObject({
                body: { error: expect.stringContaining("without workspace sharing") },
                status: 503,
            });
        } finally {
            await server.close();
        }
    });

    it("routes owner, member, replica, and health operations to the scope they name", async () => {
        const service = createStub();
        const server = await startServer(service);
        try {
            expect(
                await request(server.socketPath, "POST", SHARE_PATH, {
                    friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                    mutationId: "mutation-1",
                }),
            ).toMatchObject({ body: owner, status: 201 });
            await request(server.socketPath, "POST", `${SHARE_PATH}/members`, {
                friend: { displayName: "Second", peerId: "peer-second" },
                mutationId: "mutation-2",
            });
            await request(server.socketPath, "POST", `${SHARE_PATH}/members/member-1/revoke`, {
                mutationId: "mutation-3",
            });
            await request(server.socketPath, "POST", `${SHARE_PATH}/stop`, {
                mutationId: "mutation-4",
            });

            expect(await request(server.socketPath, "GET", SHARE_PATH)).toMatchObject({
                body: owner,
                status: 200,
            });
            const scope = { scopeId: "workspace-1", scopeKind: "workspace" };
            expect(service.create).toHaveBeenCalledWith(scope, expect.anything());
            expect(service.revoke).toHaveBeenCalledWith(scope, "member-1", expect.anything());

            expect(await request(server.socketPath, "GET", "/scope-share-replicas")).toMatchObject({
                body: { replicas: [replica] },
                status: 200,
            });
            expect(
                await request(server.socketPath, "GET", "/scope-share-replicas/wsp_share1"),
            ).toMatchObject({ body: { complete: true, entries: [], replica }, status: 200 });
            expect(
                await request(
                    server.socketPath,
                    "GET",
                    "/scope-share-replicas/wsp_share1/sessions/session-a/history?after=4",
                ),
            ).toMatchObject({ body: { sessionId: "session-a" }, status: 200 });
            expect(service.replicaSessionHistory).toHaveBeenCalledWith(
                "wsp_share1",
                "session-a",
                "4",
            );
            expect(
                await request(server.socketPath, "GET", "/scope-shares/wsp_share1/health"),
            ).toMatchObject({ body: { health: { state: "active" } }, status: 200 });
        } finally {
            await server.close();
        }
    });

    it("refuses a request body that does not match its schema", async () => {
        const server = await startServer(createStub());
        try {
            expect(
                await request(server.socketPath, "POST", SHARE_PATH, { friends: [] }),
            ).toMatchObject({ status: 400 });
            expect(await request(server.socketPath, "GET", `${SHARE_PATH}/stop`)).toMatchObject({
                status: 405,
            });
        } finally {
            await server.close();
        }
    });
});

function createStub(): ScopeShareServiceContract & {
    create: ReturnType<typeof vi.fn<ScopeShareServiceContract["create"]>>;
    replicaSessionHistory: ReturnType<
        typeof vi.fn<ScopeShareServiceContract["replicaSessionHistory"]>
    >;
    revoke: ReturnType<typeof vi.fn<ScopeShareServiceContract["revoke"]>>;
} {
    const create = vi.fn<ScopeShareServiceContract["create"]>(async () => owner);
    const replicaSessionHistory = vi.fn<ScopeShareServiceContract["replicaSessionHistory"]>(
        (_shareId, sessionId) => ({ complete: true, entries: [], replica, sessionId }),
    );
    const revoke = vi.fn<ScopeShareServiceContract["revoke"]>(async () => owner);
    return {
        add: vi.fn<ScopeShareServiceContract["add"]>(async () => owner),
        create,
        getOwner: vi.fn<ScopeShareServiceContract["getOwner"]>(() => owner),
        health: vi.fn<ScopeShareServiceContract["health"]>(() => ({
            health: { checkedAt: 1, pendingBytes: 0, pendingEntries: 0, state: "active" as const },
        })),
        listReplicas: vi.fn<ScopeShareServiceContract["listReplicas"]>(() => ({
            replicas: [replica],
        })),
        metadata: vi.fn<ScopeShareServiceContract["metadata"]>(() => owner.share),
        replica: vi.fn<ScopeShareServiceContract["replica"]>(() => ({
            complete: true,
            entries: [],
            replica,
        })),
        replicaSessionHistory,
        revoke,
        stop: vi.fn<ScopeShareServiceContract["stop"]>(async () => ({
            ...owner,
            share: { ...owner.share, state: "stopped" as const },
        })),
        stopForArchivedProject: vi.fn<ScopeShareServiceContract["stopForArchivedProject"]>(
            async () => undefined,
        ),
        stopForArchivedWorkspace: vi.fn<ScopeShareServiceContract["stopForArchivedWorkspace"]>(
            async () => undefined,
        ),
    };
}

async function startServer(
    scopeShares?: ScopeShareServiceContract,
): Promise<{ close(): Promise<void>; socketPath: string }> {
    const directory = await createTestSocketDirectory();
    const socketPath = join(directory, "server.sock");
    const server = createProtocolHttpServer({
        ...(scopeShares === undefined ? {} : { scopeShares }),
        store: new InMemorySessionStore(),
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
