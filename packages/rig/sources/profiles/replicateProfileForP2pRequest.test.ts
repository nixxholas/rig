import { afterEach, describe, expect, it, vi } from "vitest";

import type { P2pNetwork } from "../p2p/index.js";
import type { P2pHttpRequest, P2pHttpResponse } from "../p2p/P2pHttp.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import {
    P2pProfileReplicationError,
    replicateProfileForP2pRequest,
} from "./replicateProfileForP2pRequest.js";
import { RigProfileStore } from "./RigProfileStore.js";

const LOCAL_INSTANCE = "alocalparent00000000000001";
const PEER_INSTANCE = "asecondary000000000000001";

describe("replicateProfileForP2pRequest", () => {
    let database: PersistentSessionStore | undefined;

    afterEach(() => database?.close());

    it("registers a local profile before forwarding an attributed message", async () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            publish: () => undefined,
        });
        const profile = profiles.create({ name: "Steve" });
        const requests: P2pHttpRequest[] = [];
        const network = {
            fetch: vi.fn(
                async (
                    _peerId: string,
                    request: P2pHttpRequest,
                ): Promise<{ response: P2pHttpResponse; transport: "iroh" }> => {
                    requests.push(request);
                    return {
                        response:
                            request.method === "GET"
                                ? response(404, { error: "missing" })
                                : response(200, { profile }),
                        transport: "iroh",
                    };
                },
            ),
        } as unknown as P2pNetwork;

        await replicateProfileForP2pRequest({
            body: Buffer.from(JSON.stringify({ identity: profile.id, text: "Hello" })),
            network,
            path: "/sessions/asession/messages",
            peerId: PEER_INSTANCE,
            profiles,
            signal: new AbortController().signal,
        });

        expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
        expect(JSON.parse(Buffer.from(requests[1]!.body).toString("utf8"))).toEqual({ profile });
    });

    it("does not rewrite an identical replica and rejects conflicting state", async () => {
        database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: LOCAL_INSTANCE,
            publish: () => undefined,
        });
        const profile = profiles.create({ name: "Steve" });
        const fetch = vi.fn(async () => ({
            response: response(200, { profile }),
            transport: "iroh" as const,
        }));
        const network = { fetch } as unknown as P2pNetwork;
        const input = {
            body: Buffer.from(JSON.stringify({ identity: profile.id, text: "Hello" })),
            network,
            path: "/sessions/asession/messages",
            peerId: PEER_INSTANCE,
            profiles,
            signal: new AbortController().signal,
        };

        await replicateProfileForP2pRequest(input);
        expect(fetch).toHaveBeenCalledTimes(1);

        fetch.mockResolvedValueOnce({
            response: response(200, { profile: { ...profile, name: "Impostor" } }),
            transport: "iroh",
        });
        await expect(replicateProfileForP2pRequest(input)).rejects.toBeInstanceOf(
            P2pProfileReplicationError,
        );
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
