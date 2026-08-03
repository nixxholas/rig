import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ScopeShareRequestError } from "../../scope-sharing/ScopeShareRequestError.js";
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

describe("scope share HTTP API", () => {
    it("reports plainly when a server was started without sharing", async () => {
        const server = await startServer();
        try {
            expect(
                await request(server.socketPath, "GET", server.workspaceSharePath),
            ).toMatchObject({
                body: { error: expect.stringContaining("without project and workspace sharing") },
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
                await request(server.socketPath, "POST", server.workspaceSharePath, {
                    friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                    mutationId: "mutation-1",
                }),
            ).toMatchObject({ body: owner, status: 201 });
            await request(server.socketPath, "POST", `${server.workspaceSharePath}/members`, {
                friend: { displayName: "Second", peerId: "peer-second" },
                mutationId: "mutation-2",
            });
            await request(
                server.socketPath,
                "POST",
                `${server.workspaceSharePath}/members/member-1/revoke`,
                {
                    mutationId: "mutation-3",
                },
            );
            await request(server.socketPath, "POST", `${server.workspaceSharePath}/stop`, {
                mutationId: "mutation-4",
            });

            expect(
                await request(server.socketPath, "GET", server.workspaceSharePath),
            ).toMatchObject({
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

    it("shares a whole project over the same four routes", async () => {
        const service = createStub();
        const server = await startServer(service);
        try {
            expect(
                await request(server.socketPath, "POST", server.projectSharePath, {
                    friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                    mutationId: "mutation-1",
                }),
            ).toMatchObject({ status: 201 });
            await request(server.socketPath, "POST", `${server.projectSharePath}/members`, {
                friend: { displayName: "Second", peerId: "peer-second" },
                mutationId: "mutation-2",
            });
            await request(
                server.socketPath,
                "POST",
                `${server.projectSharePath}/members/member-1/revoke`,
                { mutationId: "mutation-3" },
            );
            await request(server.socketPath, "POST", `${server.projectSharePath}/stop`, {
                mutationId: "mutation-4",
            });
            expect(await request(server.socketPath, "GET", server.projectSharePath)).toMatchObject({
                status: 200,
            });

            // The project is its own scope, and naming it never reaches a workspace.
            const projectId = server.projectSharePath.split("/")[2]!;
            const scope = { scopeId: projectId, scopeKind: "project" };
            expect(service.create).toHaveBeenCalledWith(scope, expect.anything());
            expect(service.add).toHaveBeenCalledWith(scope, expect.anything());
            expect(service.revoke).toHaveBeenCalledWith(scope, "member-1", expect.anything());
            expect(service.stop).toHaveBeenCalledWith(scope, expect.anything());
            expect(service.getOwner).toHaveBeenCalledWith(scope);
        } finally {
            await server.close();
        }
    });

    it("refuses a scope the daemon does not actually hold", async () => {
        const service = createStub();
        const server = await startServer(service);
        const projectId = server.projectSharePath.split("/")[2]!;
        try {
            // A workspace belongs to one project. Naming it under a different project,
            // or naming a project that was never added, must not reach a share at all.
            expect(
                await request(
                    server.socketPath,
                    "GET",
                    `/projects/other-project/workspaces/workspace-1/share`,
                ),
            ).toMatchObject({ status: 404 });
            expect(
                await request(
                    server.socketPath,
                    "GET",
                    `/projects/${projectId}/workspaces/no-such-workspace/share`,
                ),
            ).toMatchObject({ status: 404 });
            expect(
                await request(server.socketPath, "GET", "/projects/other-project/share"),
            ).toMatchObject({ status: 404 });
            expect(service.getOwner).not.toHaveBeenCalled();
        } finally {
            await server.close();
        }
    });

    it("answers a refusal the caller can act on with a status they can read", async () => {
        const service = createStub();
        service.create.mockRejectedValueOnce(
            new ScopeShareRequestError("no_murmur_account", "Set up a Murmur account."),
        );
        service.stop.mockRejectedValueOnce(
            new ScopeShareRequestError("not_shared", "This workspace or project is not shared."),
        );
        const server = await startServer(service);
        try {
            // None of these is an internal failure, and reporting them as one leaves a
            // client with nothing to tell the person who asked.
            expect(
                await request(server.socketPath, "POST", server.projectSharePath, {
                    friends: [{ displayName: "Friend", peerId: "peer-friend" }],
                    mutationId: "mutation-1",
                }),
            ).toMatchObject({ body: { error: "Set up a Murmur account." }, status: 409 });
            expect(
                await request(server.socketPath, "POST", `${server.projectSharePath}/stop`, {
                    mutationId: "mutation-2",
                }),
            ).toMatchObject({ status: 404 });
        } finally {
            await server.close();
        }
    });

    it("refuses a request body that does not match its schema", async () => {
        const server = await startServer(createStub());
        try {
            expect(
                await request(server.socketPath, "POST", server.workspaceSharePath, {
                    friends: [],
                }),
            ).toMatchObject({ status: 400 });
            expect(
                await request(server.socketPath, "GET", `${server.workspaceSharePath}/stop`),
            ).toMatchObject({
                status: 405,
            });
        } finally {
            await server.close();
        }
    });
});

function createStub(): ScopeShareServiceContract & {
    add: ReturnType<typeof vi.fn<ScopeShareServiceContract["add"]>>;
    create: ReturnType<typeof vi.fn<ScopeShareServiceContract["create"]>>;
    getOwner: ReturnType<typeof vi.fn<ScopeShareServiceContract["getOwner"]>>;
    replicaSessionHistory: ReturnType<
        typeof vi.fn<ScopeShareServiceContract["replicaSessionHistory"]>
    >;
    revoke: ReturnType<typeof vi.fn<ScopeShareServiceContract["revoke"]>>;
    stop: ReturnType<typeof vi.fn<ScopeShareServiceContract["stop"]>>;
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

/**
 * A daemon holding one real project with one workspace in it.
 *
 * The scope a share route names has to exist, and a workspace has to be the one
 * the project in the URL actually holds, so a server with no projects at all could
 * not tell a correct route from a fabricated one.
 */
async function startServer(scopeShares?: ScopeShareServiceContract): Promise<{
    close(): Promise<void>;
    projectSharePath: string;
    socketPath: string;
    workspaceSharePath: string;
}> {
    const directory = await createTestSocketDirectory();
    const projectDirectory = await mkdtemp(join(tmpdir(), "rig-scope-share-"));
    // A project is only registered for a real repository, and the route under test is
    // exactly the one that has to tell a real scope from a fabricated one.
    execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory });
    const socketPath = join(directory, "server.sock");
    const store = new InMemorySessionStore();
    const project = await store.registerProject({ path: projectDirectory });
    const workspace = {
        createdAt: 1,
        gitCommonDir: join(projectDirectory, ".git"),
        id: "workspace-1",
        kind: "git_worktree" as const,
        name: "scope-sharing",
        orderKey: "a0",
        path: join(projectDirectory, "scope-sharing"),
        presence: "present" as const,
        projectId: project.id,
        status: "ready" as const,
        storageKey: "scope-sharing",
        updatedAt: 1,
        version: 1,
    };
    vi.spyOn(store, "getWorkspace").mockImplementation((projectId, workspaceId) =>
        projectId === project.id && workspaceId === workspace.id ? workspace : undefined,
    );
    const server = createProtocolHttpServer({
        ...(scopeShares === undefined ? {} : { scopeShares }),
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
        projectSharePath: `/projects/${project.id}/share`,
        socketPath,
        workspaceSharePath: `/projects/${project.id}/workspaces/${workspace.id}/share`,
        async close() {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { force: true, recursive: true });
            await rm(projectDirectory, { force: true, recursive: true });
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
