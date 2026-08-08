import { request, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RigProfileStore } from "../../profiles/index.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";

const PRIMARY_ID = "aprimaryinstance000000001";
const SECONDARY_ID = "asecondaryinstance0000001";
const OTHER_ID = "aotherpeerinstance00000001";
const PROFILE_ID = "aprofile000000000000000004";

describe("P2P human profiles", () => {
    const close: (() => Promise<void>)[] = [];

    afterEach(async () => {
        for (const stop of close.splice(0).reverse()) await stop();
    });

    it("accepts replicas only from the active primary and requires them on remote messages", async () => {
        const homeDirectory = await mkdtemp(join(tmpdir(), "rig-p2p-profile-"));
        close.push(() => rm(homeDirectory, { force: true, recursive: true }));
        const store = new PersistentSessionStore({
            databasePath: ":memory:",
            homeDirectory,
            projectClone: async () => undefined,
        });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: SECONDARY_ID,
            publish: () => undefined,
        });
        const localProfile = profiles.create({
            email: "secondary@example.test",
            name: "Secondary operator",
        });
        const started = await startServer(
            createProtocolHttpServer({
                canP2pPeerConfigure: (peerId) => peerId === PRIMARY_ID,
                canP2pPeerUseRemoteWork: (peerId) => peerId === PRIMARY_ID,
                p2pNode: () => ({
                    name: "Secondary",
                    primaryId: PRIMARY_ID,
                    role: "secondary",
                }),
                profiles,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            store.close();
        });
        const profile = {
            createdAt: 1_000,
            email: "steve@example.test",
            id: PROFILE_ID,
            name: "Steve",
            parentInstanceId: PRIMARY_ID,
            updatedAt: 1_000,
            version: 1,
        };
        const replicaBody = JSON.stringify({ profile });

        expect(
            await send(started.socketPath, "PUT", `/profiles/${PROFILE_ID}`, replicaBody, OTHER_ID),
        ).toMatchObject({ status: 403 });
        expect(
            await send(
                started.socketPath,
                "PUT",
                `/profiles/${PROFILE_ID}`,
                replicaBody,
                PRIMARY_ID,
            ),
        ).toMatchObject({
            body: { profile },
            status: 200,
        });
        expect(
            await send(started.socketPath, "GET", `/profiles/${PROFILE_ID}`, undefined, PRIMARY_ID),
        ).toMatchObject({ body: { profile }, status: 200 });
        expect(await send(started.socketPath, "GET", "/profiles", undefined, PRIMARY_ID)).toEqual({
            body: { profiles: [profile] },
            status: 200,
        });
        const remoteProjectRequest = {
            identity: PROFILE_ID,
            name: "Remote project",
            secret: { kind: "github" as const },
            source: { kind: "github" as const, repository: "slopus/rig" },
        };
        const managedProject = await store.createRemoteProject(remoteProjectRequest, {
            createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
            githubToken: "initial-project-token",
        });
        const session = store.create(
            {
                cwd: managedProject.path,
                identity: PROFILE_ID,
                projectId: managedProject.id,
            },
            { ownerInstanceId: PRIMARY_ID, profileId: PROFILE_ID },
        );
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sessions",
                JSON.stringify({ cwd: "/tmp/p2p-profile-created-session" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_required" }, status: 400 });
        const localSession = store.create({ cwd: "/tmp/unowned-remote-session" });
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sessions",
                JSON.stringify({
                    cwd: "/tmp/unowned-remote-session",
                    identity: PROFILE_ID,
                    projectId: localSession.snapshot().projectId,
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ status: 403 });
        expect(
            await send(
                started.socketPath,
                "POST",
                "/sessions",
                JSON.stringify({
                    cwd: managedProject.path,
                    identity: PROFILE_ID,
                    projectId: managedProject.id,
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({
            body: {
                session: {
                    ownerInstanceId: PRIMARY_ID,
                    profileId: PROFILE_ID,
                },
            },
            status: 201,
        });
        const createRemoteProject = vi.spyOn(store, "createRemoteProject");
        const remoteProject = await send(
            started.socketPath,
            "POST",
            "/projects/clone",
            JSON.stringify({
                ...remoteProjectRequest,
                projectId: managedProject.id,
                temporaryGitSecret: { kind: "github", token: "single-use-token" },
            }),
            PRIMARY_ID,
        );
        expect(remoteProject.status).toBe(202);
        expect(JSON.stringify(remoteProject.body)).not.toContain("single-use-token");
        expect(createRemoteProject).toHaveBeenCalledWith(
            { ...remoteProjectRequest, projectId: managedProject.id },
            {
                createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
                githubToken: "single-use-token",
            },
        );
        expect(
            await send(
                started.socketPath,
                "POST",
                "/projects/clone",
                JSON.stringify(remoteProjectRequest),
                "a-trusted-but-not-primary-rig",
            ),
        ).toMatchObject({ status: 403 });
        expect(createRemoteProject).toHaveBeenCalledTimes(1);
        const projectId = managedProject.id;
        const workspace = {
            branch: "001-remote-workspace",
            createdAt: 2_000,
            createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
            gitCommonDir: "/tmp/p2p-profile-secondary/.git",
            id: "aworkspace0000000000000001",
            kind: "git_worktree" as const,
            name: "Remote workspace",
            orderKey: "a0",
            path: "/tmp/p2p-profile-secondary-workspace",
            presence: "missing" as const,
            projectId,
            status: "initializing" as const,
            storageKey: "remote-workspace",
            updatedAt: 2_000,
            version: 1,
        };
        const createRemoteWorkspace = vi
            .spyOn(store, "createWorkspace")
            .mockResolvedValue(workspace);
        const remoteWorkspace = await send(
            started.socketPath,
            "POST",
            `/projects/${projectId}/workspaces`,
            JSON.stringify({
                identity: PROFILE_ID,
                name: "Remote workspace",
                secret: { kind: "github" },
                temporaryGitSecret: { kind: "github", token: "workspace-token" },
            }),
            PRIMARY_ID,
        );
        expect(remoteWorkspace).toMatchObject({
            body: { workspace: { createdBy: workspace.createdBy, id: workspace.id } },
            status: 202,
        });
        expect(JSON.stringify(remoteWorkspace.body)).not.toContain("workspace-token");
        expect(createRemoteWorkspace).toHaveBeenCalledWith(
            projectId,
            {
                identity: PROFILE_ID,
                name: "Remote workspace",
                secret: { kind: "github" },
            },
            {
                createdBy: { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
                githubToken: "workspace-token",
            },
        );
        expect(
            await send(
                started.socketPath,
                "GET",
                `/profiles/${localProfile.id}`,
                undefined,
                PRIMARY_ID,
            ),
        ).toMatchObject({ status: 404 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ text: "Missing profile" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_required" }, status: 400 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({
                    identity: "aunknownprofile000000000001",
                    text: "Wrong profile",
                }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ body: { code: "profile_not_owned" }, status: 403 });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ identity: PROFILE_ID, text: "Attributed message" }),
                PRIMARY_ID,
            ),
        ).toMatchObject({ status: 202 });
        const refreshGitCredential = vi
            .spyOn(store, "refreshSessionGitCredential")
            .mockResolvedValue(true);
        const credentialedMessage = await send(
            started.socketPath,
            "POST",
            `/sessions/${session.id}/messages`,
            JSON.stringify({
                clientSubmissionId: "credentialed-message-retry",
                gitSecret: { kind: "github" },
                identity: PROFILE_ID,
                temporaryGitSecret: { kind: "github", token: "message-token" },
                text: "Refresh Git before this run",
            }),
            PRIMARY_ID,
        );
        expect(credentialedMessage.status).toBe(202);
        expect(JSON.stringify(credentialedMessage.body)).not.toContain("message-token");
        expect(refreshGitCredential).toHaveBeenCalledWith(
            session.id,
            { instanceId: PRIMARY_ID, profileId: PROFILE_ID },
            "message-token",
        );
        const credentialedRetry = await send(
            started.socketPath,
            "POST",
            `/sessions/${session.id}/messages`,
            JSON.stringify({
                clientSubmissionId: "credentialed-message-retry",
                gitSecret: { kind: "github" },
                identity: PROFILE_ID,
                text: "Refresh Git before this run",
            }),
            PRIMARY_ID,
        );
        expect(credentialedRetry).toEqual(credentialedMessage);
        expect(refreshGitCredential).toHaveBeenCalledTimes(1);
        expect(
            session.events
                .since(undefined)
                ?.findLast((event) => event.type === "message_submitted"),
        ).toMatchObject({ data: { message: { identity: PROFILE_ID } } });
        expect(
            await send(
                started.socketPath,
                "POST",
                `/sessions/${session.id}/messages`,
                JSON.stringify({ identity: PROFILE_ID, text: "Local impersonation" }),
            ),
        ).toMatchObject({ body: { code: "profile_not_owned" }, status: 403 });
        void session.abort();
    });

    it("creates named profiles only on a local primary", async () => {
        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database: store,
            localInstanceId: PRIMARY_ID,
            publish: () => undefined,
        });
        const started = await startServer(
            createProtocolHttpServer({
                p2pNode: () => ({ name: "Primary", role: "primary" }),
                profiles,
                store,
                token: "secret",
            }),
        );
        close.push(async () => {
            await started.close();
            store.close();
        });

        expect(
            await send(
                started.socketPath,
                "POST",
                "/profiles",
                JSON.stringify({ name: "Missing email" }),
            ),
        ).toMatchObject({ status: 400 });
        const created = await send(
            started.socketPath,
            "POST",
            "/profiles",
            JSON.stringify({
                email: "steve@example.test",
                name: "Steve Korshakov 🧑‍💻",
            }),
        );
        expect(created).toMatchObject({
            body: {
                profile: {
                    email: "steve@example.test",
                    id: expect.any(String),
                    name: "Steve Korshakov 🧑‍💻",
                    parentInstanceId: PRIMARY_ID,
                    version: 1,
                },
            },
            status: 201,
        });
    });
});

async function send(
    socketPath: string,
    method: string,
    path: string,
    body?: string,
    peerId?: string,
): Promise<{ body: unknown; status: number }> {
    return await new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: "Bearer secret",
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body),
                              "content-type": "application/json",
                          }),
                    ...(peerId === undefined ? {} : { "x-rig-p2p-peer": peerId }),
                },
                method,
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk) =>
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
                );
                response.once("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        body: text.length === 0 ? undefined : JSON.parse(text),
                        status: response.statusCode ?? 0,
                    });
                });
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

async function startServer(server: Server): Promise<{
    close: () => Promise<void>;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    return {
        close: async () => {
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error === undefined ? resolve() : reject(error))),
            );
            await rm(directory, { force: true, recursive: true });
        },
        socketPath,
    };
}
