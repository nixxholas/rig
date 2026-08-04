import { rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SessionShareServiceContract } from "../../session-sharing/index.js";
import { FakeShareTransport } from "../../sharing/FakeShareTransport.js";
import { SessionShareDaemonService } from "../../session-sharing/SessionShareDaemonService.js";
import { SessionShareService } from "../../session-sharing/SessionShareService.js";
import { InMemorySessionStore } from "../../session/InMemorySessionStore.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import type { SessionStore } from "../../session/SessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const grant = {
    grantEpoch: 1,
    murmurPeerId: "peer-friend",
    shareId: "share-1",
    shareMemberId: "member-1",
};
const member = {
    capabilities: [],
    capabilitiesDescription: "Read the conversation only",
    createdAt: 1,
    currentGrantEpoch: 1,
    displayName: "Friend",
    murmurPeerId: "peer-friend",
    shareId: "share-1",
    shareMemberId: "member-1",
    state: "active" as const,
    updatedAt: 1,
};
const offerableCapabilities = [
    {
        capability: "terminal_view" as const,
        description:
            "They can watch a container terminal in this session as you use it. They cannot type into it, resize it, or run anything.",
        label: "Watch a terminal",
        offerable: true,
    },
];
const owner = {
    members: [member],
    share: {
        capabilityMemberCount: 0,
        includeFriendMessagesInModel: true,
        memberCount: 1,
        offerableCapabilities,
        shareId: "share-1",
        state: "active" as const,
        toolOutput: "summaries" as const,
        toolOutputDescription: "Friends see what each tool did, without the output it produced.",
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
    it("reports plainly when a server was started without session sharing", async () => {
        const server = await startServer();
        try {
            const response = await request(server.socketPath, "GET", "/sessions/session-1/share");
            expect(response).toMatchObject({
                status: 503,
                body: {
                    error: expect.stringContaining("without session sharing"),
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
            await request(server.socketPath, "POST", "/sessions/session-1/share/tool-output", {
                mutationId: "mutation-5",
                toolOutput: "full",
            });
            await request(server.socketPath, "POST", "/sessions/session-1/share/stop", {
                mutationId: "mutation-6",
            });
            expect(
                await request(
                    server.socketPath,
                    "PUT",
                    "/sessions/session-1/share/members/member%2F1/capabilities",
                    { capabilities: ["terminal_view"], mutationId: "mutation-7" },
                ),
            ).toMatchObject({ body: owner, status: 200 });
            expect(
                await request(
                    server.socketPath,
                    "GET",
                    "/sessions/session-1/share/peer-activity?after=42",
                ),
            ).toMatchObject({
                body: expect.objectContaining({ complete: true }),
                status: 200,
            });
            expect(
                await request(
                    server.socketPath,
                    "GET",
                    "/session-share-replicas/share-1/capabilities",
                ),
            ).toMatchObject({
                body: {
                    capabilities: ["terminal_view"],
                    description: "Watch a terminal",
                    shareId: "share-1",
                },
                status: 200,
            });
            // A member asking the owner to mirror a terminal. The answer says only
            // that the request went out: whether it is honoured is decided on the
            // owner's side, against the owner's grants and the owner's container.
            expect(
                await request(
                    server.socketPath,
                    "POST",
                    "/session-share-replicas/share-1/terminal",
                    {
                        terminalId: "terminal-1",
                    },
                ),
            ).toMatchObject({ body: { requested: true }, status: 200 });
            expect(service.requestPeerTerminal).toHaveBeenCalledWith("share-1", "terminal-1");
            expect(
                await request(
                    server.socketPath,
                    "POST",
                    "/session-share-replicas/share-1/terminal",
                    {
                        notATerminalId: "x",
                    },
                ),
            ).toMatchObject({ status: 400 });
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
            expect(service.setToolOutput).toHaveBeenCalledWith("session-1", {
                mutationId: "mutation-5",
                toolOutput: "full",
            });
            expect(service.setMemberCapabilities).toHaveBeenCalledWith("session-1", "member/1", {
                capabilities: ["terminal_view"],
                mutationId: "mutation-7",
            });
            expect(service.peerActivity).toHaveBeenCalledWith("session-1", "42");
            expect(service.replicaCapabilities).toHaveBeenCalledWith("share-1");
        } finally {
            await server.close();
        }
    });

    it("only ever raises tool-output disclosure to a setting the owner named", async () => {
        const service = createStub();
        const server = await startServer(service);
        try {
            // A share created without saying anything about tool output is asking
            // for none, so the request carries no setting at all rather than one
            // the client guessed.
            expect(
                await request(server.socketPath, "POST", "/sessions/session-1/share", {
                    friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                    includeFriendMessagesInModel: true,
                    mutationId: "mutation-1",
                }),
            ).toMatchObject({ status: 201 });
            expect(service.create).toHaveBeenCalledWith(
                "session-1",
                expect.not.objectContaining({ toolOutput: expect.anything() }),
            );

            // A setting nobody defined is refused outright: it must not be read as
            // an instruction to disclose, and it must not be quietly accepted.
            for (const body of [
                { mutationId: "mutation-2", toolOutput: "everything" },
                { mutationId: "mutation-3" },
                { mutationId: "mutation-4", toolOutput: true },
            ]) {
                expect(
                    await request(
                        server.socketPath,
                        "POST",
                        "/sessions/session-1/share/tool-output",
                        body,
                    ),
                ).toMatchObject({
                    body: { error: "The tool-output setting is invalid." },
                    status: 400,
                });
            }
            expect(service.setToolOutput).not.toHaveBeenCalled();
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

    it("rejects missing and subagent owner sessions without calling the sharing service", async () => {
        const service = createStub();
        const store = new InMemorySessionStore();
        store.createWithId("session-1", { cwd: "/tmp/session-share-primary" });
        const subagent = store.createWithId("subagent-1", {
            cwd: "/tmp/session-share-subagent",
        });
        vi.spyOn(subagent, "agentMetadata").mockReturnValue({
            depth: 1,
            parentSessionId: "session-1",
            rootSessionId: "session-1",
            type: "subagent",
        });
        const server = await startServer(service, store);
        try {
            expect(
                await request(server.socketPath, "GET", "/sessions/missing/share"),
            ).toMatchObject({
                body: { error: "Session not found." },
                status: 404,
            });
            const rejectedOwnerRequests = [
                request(server.socketPath, "GET", "/sessions/subagent-1/share"),
                request(server.socketPath, "POST", "/sessions/subagent-1/share", {
                    friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                    includeFriendMessagesInModel: true,
                    mutationId: "mutation-create",
                }),
                request(server.socketPath, "POST", "/sessions/subagent-1/share/members", {
                    friend: { displayName: "Friend", peerId: "peer-friend" },
                    mutationId: "mutation-add",
                }),
                request(
                    server.socketPath,
                    "POST",
                    "/sessions/subagent-1/share/members/member-1/revoke",
                    { mutationId: "mutation-revoke" },
                ),
                request(server.socketPath, "POST", "/sessions/subagent-1/share/stop", {
                    mutationId: "mutation-stop",
                }),
                request(server.socketPath, "POST", "/sessions/subagent-1/share/friend-messages", {
                    includeFriendMessagesInModel: false,
                    mutationId: "mutation-toggle",
                }),
                request(server.socketPath, "POST", "/sessions/subagent-1/share/tool-output", {
                    mutationId: "mutation-tool-output",
                    toolOutput: "full",
                }),
            ];
            for (const response of await Promise.all(rejectedOwnerRequests)) {
                expect(response).toMatchObject({
                    body: { error: "Only primary sessions can be shared." },
                    status: 409,
                });
            }
            expect(service.getOwner).not.toHaveBeenCalled();
            expect(service.create).not.toHaveBeenCalled();
            expect(service.add).not.toHaveBeenCalled();
            expect(service.revoke).not.toHaveBeenCalled();
            expect(service.stop).not.toHaveBeenCalled();
            expect(service.setFriendMessages).not.toHaveBeenCalled();
            expect(service.setToolOutput).not.toHaveBeenCalled();

            expect(
                await request(server.socketPath, "GET", "/session-share-replicas"),
            ).toMatchObject({ body: { replicas: [replica] }, status: 200 });
            expect(
                await request(server.socketPath, "GET", "/session-shares/share-1/health"),
            ).toMatchObject({ status: 200 });
        } finally {
            await server.close();
        }
    });

    it("creates a share and reads it back over HTTP through a real SessionShareDaemonService", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        const transport = new FakeShareTransport();
        const sessionShares = new SessionShareDaemonService({
            localPeerId: async () => "peer-owner",
            offerableCapabilities: () => [],
            service: new SessionShareService({
                deliverFriendMessage: () => undefined,
                store: store.sessionShares,
                transport,
            }),
            store: store.sessionShareDaemonStore,
        });
        store.createWithId("session-real-1", { cwd: "/tmp/session-share-real" });
        const server = await startServer(sessionShares, store);
        try {
            const created = await request(
                server.socketPath,
                "POST",
                "/sessions/session-real-1/share",
                {
                    friends: [{ displayName: "Casey", peerId: "peer-casey" }],
                    includeFriendMessagesInModel: true,
                    mutationId: "mutation-1",
                },
            );
            expect(created).toMatchObject({
                body: {
                    members: [
                        expect.objectContaining({
                            displayName: "Casey",
                            murmurPeerId: "peer-casey",
                            state: "active",
                        }),
                    ],
                    share: {
                        includeFriendMessagesInModel: true,
                        memberCount: 1,
                        state: "active",
                    },
                },
                status: 201,
            });

            expect(
                await request(server.socketPath, "GET", "/sessions/session-real-1/share"),
            ).toEqual({ body: created.body, status: 200 });
        } finally {
            await server.close();
            store.close();
        }
    });
});

function createStub(): SessionShareServiceContract & {
    create: ReturnType<typeof vi.fn<SessionShareServiceContract["create"]>>;
    peerActivity: ReturnType<typeof vi.fn<SessionShareServiceContract["peerActivity"]>>;
    replicaCapabilities: ReturnType<
        typeof vi.fn<SessionShareServiceContract["replicaCapabilities"]>
    >;
    replicaHistory: ReturnType<typeof vi.fn<SessionShareServiceContract["replicaHistory"]>>;
    requestPeerTerminal: ReturnType<
        typeof vi.fn<SessionShareServiceContract["requestPeerTerminal"]>
    >;
    revoke: ReturnType<typeof vi.fn<SessionShareServiceContract["revoke"]>>;
    setMemberCapabilities: ReturnType<
        typeof vi.fn<SessionShareServiceContract["setMemberCapabilities"]>
    >;
} {
    const create = vi.fn<SessionShareServiceContract["create"]>(async () => owner);
    const peerActivity = vi.fn<SessionShareServiceContract["peerActivity"]>(() => ({
        complete: true,
        entries: [
            {
                action: "attach",
                capability: "terminal_view" as const,
                createdAt: 1,
                description: "Friend started to watch a terminal.",
                grantEpoch: 1,
                outcome: "allowed" as const,
                seq: 1,
                shareId: "share-1",
                shareMemberId: "member-1",
            },
        ],
    }));
    const replicaCapabilities = vi.fn<SessionShareServiceContract["replicaCapabilities"]>(() => ({
        capabilities: ["terminal_view" as const],
        description: "Watch a terminal",
        shareId: "share-1",
    }));
    const replicaHistory = vi.fn<SessionShareServiceContract["replicaHistory"]>(() => ({
        complete: true,
        entries: [],
        replica,
    }));
    const requestPeerTerminal = vi.fn<SessionShareServiceContract["requestPeerTerminal"]>(
        async () => ({ requested: true }),
    );
    const revoke = vi.fn<SessionShareServiceContract["revoke"]>(async () => owner);
    const setMemberCapabilities = vi.fn<SessionShareServiceContract["setMemberCapabilities"]>(
        async () => owner,
    );
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
        peerActivity,
        postFriendMessage: vi.fn<SessionShareServiceContract["postFriendMessage"]>(
            async (post) => ({
                accepted: true,
                clientMessageId: post.clientMessageId,
            }),
        ),
        replicaCapabilities,
        replicaHistory,
        requestPeerTerminal,
        revoke,
        setFriendMessages: vi.fn<SessionShareServiceContract["setFriendMessages"]>(
            async () => owner,
        ),
        setMemberCapabilities,
        setToolOutput: vi.fn<SessionShareServiceContract["setToolOutput"]>(async () => owner),
        stop: vi.fn<SessionShareServiceContract["stop"]>(async () => ({
            ...owner,
            share: { ...owner.share, state: "stopped" as const },
        })),
        stopForArchivedSession: vi.fn<SessionShareServiceContract["stopForArchivedSession"]>(
            async () => undefined,
        ),
    };
}

async function startServer(
    sessionShares?: SessionShareServiceContract,
    providedStore?: SessionStore,
): Promise<{
    close(): Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = join(directory, "server.sock");
    const store = providedStore ?? new InMemorySessionStore();
    if (store.get("session-1") === undefined) {
        store.createWithId("session-1", { cwd: "/tmp/session-share-owner" });
    }
    const server = createProtocolHttpServer({
        ...(sessionShares === undefined ? {} : { sessionShares }),
        store,
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
    method: "GET" | "POST" | "PUT",
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
