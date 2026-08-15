import { request } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { rm } from "node:fs/promises";

import { Endpoint, RelayMode, SecretKey } from "@number0/iroh/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestRootContext } from "../../testing/createTestRootContext.js";

import { IrohNetwork, P2pNetwork } from "../../p2p/index.js";
import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { createP2pInstanceIdentity } from "../../p2p/P2pIdentity.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { createProtocolHttpServer } from "../createProtocolHttpServer.js";
import { createServeP2pHttpRequest } from "../createServeP2pHttpRequest.js";
import { createServeP2pTunnel } from "../createServeP2pTunnel.js";
import type { P2pPeerTrustStoreContract } from "../../p2p/P2pPeerTrustStore.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { RigProfileStore } from "../../profiles/index.js";
import type { Project, RigProfile } from "../../protocol/index.js";
import { isP2pRemoteWorkPath } from "../runLocalProtocolServer.js";

const ALPN = [...Buffer.from("rig/p2p/5", "utf8")];
const PROFILE_ID = "aprofile000000000000000005";
const cleanups: (() => Promise<void>)[] = [];
const peerTrustStore: P2pPeerTrustStoreContract = {
    preparePairing: async () => {
        throw new Error("Pairing is not used by this test.");
    },
    peerForBinding: async () => undefined,
    peers: async () => [],
    readyPairings: async () => [],
    validate: async () => undefined,
    verifyOrPin: async () => undefined,
};

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("P2P shared work routes", () => {
    it.each([
        ["GET", "/projects"],
        ["POST", "/projects/project-id/workspaces"],
        ["GET", "/projects/project-id/terminals"],
        ["POST", "/projects/project-id/terminals"],
        ["POST", "/sessions/session-id/messages"],
        ["POST", "/sessions/session-id/abort"],
        ["POST", "/sessions/session-id/terminals"],
        ["GET", "/sessions/session-id/terminals/terminal-id"],
    ])("allows %s %s", (method, path) => {
        expect(isP2pRemoteWorkPath(path, method)).toBe(true);
    });

    it.each([
        ["GET", "/config"],
        ["PUT", "/config/security"],
        ["GET", "/inference-credentials"],
        ["GET", "/health"],
    ])("keeps %s %s outside shared work access", (method, path) => {
        expect(isP2pRemoteWorkPath(path, method)).toBe(false);
    });
});

describe("P2P HTTP between two real daemon servers", () => {
    it("serves request/response and live events through the local peer prefix", async () => {
        const firstKey = SecretKey.generate();
        const secondKey = SecretKey.generate();
        const firstIdentity = createP2pInstanceIdentity();
        const secondIdentity = createP2pInstanceIdentity();
        const remoteProfile: RigProfile = {
            createdAt: 1,
            email: "steve@example.test",
            id: PROFILE_ID,
            name: "Steve",
            parentInstanceId: firstIdentity.instanceId,
            updatedAt: 1,
            version: 1,
        };
        const firstDaemon = await startDaemon("first-token");
        const secondDaemon = await startDaemon("second-token", undefined, {
            allowedProvisionPeerId: firstIdentity.instanceId,
            localInstanceId: secondIdentity.instanceId,
            remoteProfile,
        });
        const [firstEndpoint, secondEndpoint] = await Promise.all([
            Endpoint.bind({ alpns: [ALPN], secretKey: firstKey.toBytes() }, RelayMode.disabled()),
            Endpoint.bind({ alpns: [ALPN], secretKey: secondKey.toBytes() }, RelayMode.disabled()),
        ]);
        const firstId = firstEndpoint.id().toString();
        const secondId = secondEndpoint.id().toString();
        const firstNetwork = await P2pNetwork.create(createTestRootContext(), {
            config: {
                direct: {},
                enableDirect: false,
                enableIroh: true,
                enableSsh: false,
                exposeApi: false,
                iroh: {},
                name: "First",
                role: "primary",
            },
            createIrohTransport: (onStatusChange) =>
                IrohNetwork.create({
                    config: {},
                    endpointIds: [secondId],
                    endpoint: firstEndpoint,
                    identity: firstIdentity,
                    knownPeer: () => ({ ...secondIdentity, name: "Second" }),
                    onStatusChange,
                    peerAddresses: new Map([[secondId, secondEndpoint.addr()]]),
                    relayMode: RelayMode.disabled(),
                    secretKey: firstKey,
                }),
            irohSecretKeyPath: "unused",
            identity: firstIdentity,
            peerTrustStore,
        });
        cleanups.push(() => firstNetwork.close());
        const secondNetwork = await P2pNetwork.create(createTestRootContext(), {
            config: {
                direct: {},
                enableDirect: false,
                enableIroh: true,
                enableSsh: false,
                exposeApi: false,
                iroh: {},
                name: "Second",
                role: "primary",
            },
            createIrohTransport: (onStatusChange) =>
                IrohNetwork.create({
                    config: {},
                    endpointIds: [firstId],
                    endpoint: secondEndpoint,
                    identity: secondIdentity,
                    knownPeer: () => ({ ...firstIdentity, name: "First" }),
                    onStatusChange,
                    peerAddresses: new Map([[firstId, firstEndpoint.addr()]]),
                    relayMode: RelayMode.disabled(),
                    secretKey: secondKey,
                    serveRequest: createServeP2pHttpRequest({
                        allowRequest: (peerId, incoming) =>
                            peerId === firstIdentity.instanceId &&
                            isP2pRemoteWorkPath(incoming.path, incoming.method),
                        socketPath: secondDaemon.socketPath,
                        token: "second-token",
                    }),
                    serveTunnel: createServeP2pTunnel({
                        socketPath: secondDaemon.socketPath,
                        token: "second-token",
                    }),
                }),
            irohSecretKeyPath: "unused",
            identity: secondIdentity,
            peerTrustStore,
        });
        cleanups.push(() => secondNetwork.close());
        await vi.waitFor(() => {
            expect(firstNetwork.status().transports[0]).toMatchObject({
                peers: [
                    {
                        name: "Second",
                        peerId: secondIdentity.instanceId,
                        status: "connected",
                    },
                ],
            });
            expect(secondNetwork.status().transports[0]).toMatchObject({
                peers: [
                    {
                        name: "First",
                        peerId: firstIdentity.instanceId,
                        status: "connected",
                    },
                ],
            });
        });

        firstDaemon.server.closeAllConnections();
        await firstDaemon.close();
        const exposedFirst = await startDaemon("first-token", firstNetwork);
        const health = await get(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/health`,
            "first-token",
        );
        expect(health.status).toBe(403);
        const catalog = await get(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/catalog`,
            "first-token",
        );
        expect(catalog.status).toBe(200);
        expect(catalog.headers["x-rig-p2p-peer"]).toBe(secondIdentity.instanceId);

        const hello = await readFirstSseFrame(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/events/live`,
            "first-token",
        );
        expect(hello).toContain("event: hello");

        const peerClient = new ProtocolHttpClient({
            pathPrefix: `/p2p/peers/${secondIdentity.instanceId}/api`,
            socketPath: exposedFirst.socketPath,
            token: "first-token",
        });
        const createdSession = await peerClient.createSession({
            cwd: secondDaemon.remoteProject!.path,
            identity: PROFILE_ID,
            projectId: secondDaemon.remoteProject!.id,
        });
        const sessionState = await get(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/sessions/${createdSession.session.id}/state`,
            "first-token",
        );
        expect(sessionState.status).toBe(200);
        expect(JSON.parse(sessionState.body)).toHaveProperty("session");
        const gitWatch = await post(
            exposedFirst.socketPath,
            `/p2p/peers/${secondIdentity.instanceId}/api/git/watch`,
            "first-token",
            JSON.stringify({
                entities: [{ projectId: secondDaemon.remoteProject!.id }],
            }),
        );
        expect(gitWatch.status).toBe(503);
        const exposedSecond = await startDaemon("second-token", secondNetwork);
        const refusal = await get(
            exposedSecond.socketPath,
            `/p2p/peers/${firstIdentity.instanceId}/api/health`,
            "second-token",
        );
        expect(refusal.status).toBe(403);
        expect(JSON.parse(refusal.body)).toEqual({
            error: "P2P API sharing is disabled for that peer connection.",
        });
    });
});

async function startDaemon(
    token: string,
    p2pNetwork?: P2pNetwork,
    options?: {
        allowedProvisionPeerId: string;
        localInstanceId: string;
        remoteProfile: RigProfile;
    },
): Promise<{
    close: () => Promise<void>;
    remoteProject?: Project;
    server: Server;
    socketPath: string;
}> {
    const directory = await createTestSocketDirectory();
    const socketPath = `${directory}/server.sock`;
    const store =
        options === undefined
            ? undefined
            : await PersistentSessionStore.open(createTestRootContext(), {
                  databasePath: ":memory:",
                  homeDirectory: directory,
                  localInstanceId: options.localInstanceId,
                  projectClone: async () => undefined,
              });
    const profiles =
        store === undefined
            ? undefined
            : new RigProfileStore({
                  database: store,
                  localInstanceId: options!.localInstanceId,
                  publish: () => undefined,
              });
    await profiles?.replicate(
        createTestRootContext(),
        options!.remoteProfile,
        options!.allowedProvisionPeerId,
    );
    const remoteProject =
        store === undefined
            ? undefined
            : await store.createRemoteProject(
                  createTestRootContext(),
                  {
                      identity: options!.remoteProfile.id,
                      name: "Peer managed project",
                      secret: { kind: "github" },
                      source: { kind: "github", repository: "slopus/rig" },
                  },
                  {
                      createdBy: {
                          instanceId: options!.allowedProvisionPeerId,
                          profileId: options!.remoteProfile.id,
                      },
                      githubToken: "test-github-token",
                  },
              );
    const server = await createProtocolHttpServer(createTestRootContext(), {
        ...(options === undefined
            ? {}
            : {
                  canP2pPeerProvision: (peerId: string) =>
                      peerId === options.allowedProvisionPeerId,
                  canP2pPeerUseRemoteWork: (peerId: string) =>
                      peerId === options.allowedProvisionPeerId,
              }),
        ...(p2pNetwork === undefined ? {} : { p2pNetwork }),
        ...(profiles === undefined ? {} : { profiles }),
        ...(store === undefined ? {} : { store }),
        token,
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
        });
    });
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
        await store?.close(createTestRootContext());
        await rm(directory, { force: true, recursive: true });
    };
    cleanups.push(close);
    return {
        close,
        ...(remoteProject === undefined ? {} : { remoteProject }),
        server,
        socketPath,
    };
}

function get(
    socketPath: string,
    path: string,
    token: string,
): Promise<{
    body: string;
    headers: IncomingHttpHeaders;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            { headers: { authorization: `Bearer ${token}` }, path, socketPath },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        outgoing.once("error", reject);
        outgoing.end();
    });
}

function post(
    socketPath: string,
    path: string,
    token: string,
    body: string,
): Promise<{
    body: string;
    headers: IncomingHttpHeaders;
    status: number;
}> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-length": Buffer.byteLength(body),
                    "content-type": "application/json",
                },
                method: "POST",
                path,
                socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        body: Buffer.concat(chunks).toString("utf8"),
                        headers: response.headers,
                        status: response.statusCode ?? 0,
                    }),
                );
            },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
    });
}

function readFirstSseFrame(socketPath: string, path: string, token: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const outgoing = request(
            {
                headers: {
                    accept: "text/event-stream",
                    authorization: `Bearer ${token}`,
                },
                path,
                socketPath,
            },
            (response) => {
                let received = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    received += chunk;
                    if (!received.includes("event: hello")) return;
                    response.destroy();
                    outgoing.destroy();
                    resolve(received);
                });
            },
        );
        outgoing.once("error", (error) => {
            if (!outgoing.destroyed) reject(error);
        });
        outgoing.end();
    });
}
