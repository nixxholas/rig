import { afterEach, describe, expect, it, vi } from "vitest";

import type { P2pNetwork } from "../p2p/index.js";
import type { P2pHttpRequest, P2pHttpResponse } from "../p2p/P2pHttp.js";
import type { RigProfile } from "../protocol/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { P2pProfileReplicator } from "./P2pProfileReplicator.js";
import { replicateProfileToP2pPeer } from "./replicateProfileForP2pRequest.js";
import { RigProfileStore } from "./RigProfileStore.js";

const LOCAL_INSTANCE = "alocalparent00000000000001";
const SECONDARY_INSTANCE = "asecondary000000000000001";
const OTHER_INSTANCE = "aotherpeer0000000000000001";

describe("P2pProfileReplicator", () => {
    let database: PersistentSessionStore | undefined;
    let replicator: P2pProfileReplicator | undefined;

    afterEach(async () => {
        await replicator?.close();
        database?.close();
        vi.useRealTimers();
    });

    it("synchronizes updates only after a peer proves this Rig is its primary", async () => {
        vi.useFakeTimers();
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            publish: () => undefined,
        });
        const created = profiles.create({ name: "Steve" });
        const remoteProfiles = new Map<string, RigProfile>();
        const requests: { method: string; path: string; peerId: string }[] = [];
        const firstPutStarted = deferred();
        const releaseFirstPut = deferred();
        let delayFirstPut = true;
        const network = {
            fetch: vi.fn(
                async (
                    peerId: string,
                    request: P2pHttpRequest,
                ): Promise<{ response: P2pHttpResponse; transport: "iroh" }> => {
                    requests.push({ method: request.method, path: request.path, peerId });
                    if (request.path === "/config") {
                        return {
                            response: response(
                                peerId === SECONDARY_INSTANCE ? 200 : 403,
                                peerId === SECONDARY_INSTANCE
                                    ? {
                                          config: {
                                              p2p: {
                                                  primaryId: LOCAL_INSTANCE,
                                                  role: "secondary",
                                              },
                                          },
                                      }
                                    : {},
                            ),
                            transport: "iroh",
                        };
                    }
                    const profileId = request.path.slice("/profiles/".length);
                    if (request.method === "GET") {
                        const current = remoteProfiles.get(profileId);
                        return {
                            response:
                                current === undefined
                                    ? response(404, { error: "missing" })
                                    : response(200, { profile: current }),
                            transport: "iroh",
                        };
                    }
                    const decoded = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
                        profile: RigProfile;
                    };
                    if (delayFirstPut) {
                        delayFirstPut = false;
                        firstPutStarted.resolve();
                        await releaseFirstPut.promise;
                    }
                    remoteProfiles.set(profileId, decoded.profile);
                    return {
                        response: response(200, { profile: decoded.profile }),
                        transport: "iroh",
                    };
                },
            ),
        } as unknown as P2pNetwork;
        replicator = new P2pProfileReplicator({
            listPeerIds: () => [SECONDARY_INSTANCE, OTHER_INSTANCE],
            localInstanceId: LOCAL_INSTANCE,
            network,
            profiles,
        });

        replicator.syncAll({ recheckTargets: true });
        await replicator.flush();

        expect(remoteProfiles.get(created.id)).toBeUndefined();
        expect(
            requests
                .filter((request) => request.peerId === OTHER_INSTANCE)
                .map(({ method, path }) => `${method} ${path}`),
        ).toEqual(["GET /config"]);

        const preflight = replicateProfileToP2pPeer({
            network,
            peerId: SECONDARY_INSTANCE,
            profile: created,
            signal: new AbortController().signal,
        });
        await firstPutStarted.promise;

        const updated = profiles.update(created.id, { name: "Steve 🧑‍💻" });
        expect(updated).toBeDefined();
        replicator.syncProfile(created.id, updated!.version);
        await replicator.flush();
        expect(remoteProfiles.get(created.id)).toBeUndefined();

        releaseFirstPut.resolve();
        await preflight;
        expect(remoteProfiles.get(created.id)).toEqual(created);

        await vi.advanceTimersByTimeAsync(1_000);
        await replicator.flush();

        expect(remoteProfiles.get(created.id)).toEqual(updated);
        expect(
            requests.filter(
                (request) =>
                    request.peerId === SECONDARY_INSTANCE &&
                    request.method === "PUT" &&
                    request.path === `/profiles/${created.id}`,
            ),
        ).toHaveLength(2);
    });
});

function response(status: number, payload: unknown): P2pHttpResponse {
    const body = Buffer.from(JSON.stringify(payload));
    return {
        body: (async function* () {
            yield body;
        })(),
        headers: { "content-type": "application/json" },
        status,
    };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((onResolve) => {
        resolve = onResolve;
    });
    return { promise, resolve };
}
