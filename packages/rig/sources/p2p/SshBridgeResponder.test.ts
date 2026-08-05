import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { ConfigP2pPeer, ConfigP2pSshPeer } from "../config/types.js";
import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";
import { SshBridgeResponder } from "./SshBridgeResponder.js";
import { SshTransport, type SshBridgeChannel } from "./SshTransport.js";

const hostKeyHash = new Uint8Array(createHash("sha256").update("ssh host").digest());
const ssh: ConfigP2pSshPeer = {
    agentSocketPath: "/unused",
    auth: "agent",
    host: "example.test",
    hostKeySha256: `SHA256:${Buffer.from(hostKeyHash).toString("base64")}`,
    port: 22,
    remoteRig: "rig",
    username: "steve",
};

describe("SSH bridge responder", () => {
    it("mutually authenticates allowlisted identities and serves framed HTTP", async () => {
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const initiatorPeer = peer(initiatorIdentity);
        const responderPeer = peer(responderIdentity);
        const committed = vi.fn(async () => undefined);
        const responder = new SshBridgeResponder({
            commitPeer: committed,
            identity: responderIdentity,
            peers: [initiatorPeer],
            serveRequest: async (peerId, request) => ({
                body: (async function* () {
                    yield Buffer.from(`${peerId}:${request.path}`);
                })(),
                headers: { "content-type": "text/plain" },
                status: 200,
            }),
        });
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            openChannel: () => Promise.resolve(bridgeChannel(responder)),
            peers: [responderPeer],
        });

        const response = await transport.fetch(
            responderIdentity.instanceId,
            { body: Buffer.alloc(0), headers: {}, method: "GET", path: "/health" },
            new AbortController().signal,
        );
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk));

        expect(response.status).toBe(200);
        expect(Buffer.concat(chunks).toString()).toBe(`${initiatorIdentity.instanceId}:/health`);
        expect(committed).toHaveBeenCalledWith(
            expect.objectContaining({ instanceId: initiatorIdentity.instanceId }),
            initiatorIdentity.publicKey,
        );
        await transport.close();
        responder.close();
    });

    it("refuses an authenticated SSH user whose Rig identity is not allowlisted", async () => {
        const initiatorIdentity = createP2pInstanceIdentity();
        const responderIdentity = createP2pInstanceIdentity();
        const responder = new SshBridgeResponder({
            identity: responderIdentity,
            peers: [],
            serveRequest: vi.fn(),
        });
        const transport = SshTransport.create({
            identity: initiatorIdentity,
            openChannel: () => Promise.resolve(bridgeChannel(responder)),
            peers: [peer(responderIdentity)],
        });

        await expect(
            transport.ping(responderIdentity.instanceId, new AbortController().signal),
        ).rejects.toThrow();
        expect(transport.status().peers[0]).toMatchObject({ status: "unreachable" });
        await transport.close();
        responder.close();
    });
});

function peer(identity: ReturnType<typeof createP2pInstanceIdentity>): ConfigP2pPeer {
    return { instanceId: identity.instanceId, publicKey: identity.publicKey, ssh };
}

function bridgeChannel(responder: SshBridgeResponder): SshBridgeChannel {
    const toResponder = new PassThrough();
    const fromResponder = new PassThrough();
    void responder
        .acceptFrames(createNodeFrameDuplex(toResponder, fromResponder))
        .catch((error: unknown) => fromResponder.destroy(error as Error))
        .finally(() => fromResponder.end());
    return {
        close: () => {
            toResponder.destroy();
            fromResponder.destroy();
        },
        diagnostics: () => "",
        duplex: createNodeFrameDuplex(fromResponder, toResponder),
        hostKeyHash,
    };
}
