import { describe, expect, it, vi } from "vitest";

import type { P2pTransportStatus } from "../protocol/P2pProtocol.js";
import type { P2pTransport } from "./P2pTransport.js";
import { P2pNetwork } from "./P2pNetwork.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";

const disabledConfig = {
    enableIroh: false,
    exposeApi: false,
    iroh: { trustedEndpointIds: [] },
} as const;
const identity = createP2pInstanceIdentity("alocalinstance00000000001");
const peerId = "aremoteinstance0000000001";

describe("P2pNetwork", () => {
    it("starts with no transports when all transports are disabled", async () => {
        const network = await P2pNetwork.create({
            config: disabledConfig,
            identity,
            irohSecretKeyPath: "unused",
        });

        expect(network.status()).toMatchObject({
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
            transports: [],
        });
        await network.close();
    });

    it("contains one transport failure without failing the P2P service", async () => {
        const unavailable = vi.fn();
        const network = await P2pNetwork.create({
            config: { ...disabledConfig, enableIroh: true },
            createIrohTransport: async () => {
                throw new Error("binding unavailable");
            },
            identity,
            irohSecretKeyPath: "unused",
            onTransportUnavailable: unavailable,
        });

        expect(network.status()).toEqual({
            instanceId: identity.instanceId,
            publicKey: identity.publicKey,
            transports: [
                {
                    error: "binding unavailable",
                    state: "unavailable",
                    transport: "iroh",
                },
            ],
        });
        expect(unavailable).toHaveBeenCalledOnce();
        await network.close();
    });

    it("aggregates transport status changes and closes enabled transports", async () => {
        const changed = vi.fn();
        const close = vi.fn(async () => undefined);
        let publish!: (status: P2pTransportStatus) => void;
        const initial: Extract<P2pTransportStatus, { state: "ready" }> = {
            apiExposed: false,
            localAddress: "local",
            peers: [],
            state: "ready",
            transport: "iroh",
        };
        const transport: P2pTransport = {
            close,
            kind: "iroh",
            status: () => initial,
        };
        const network = await P2pNetwork.create({
            config: { ...disabledConfig, enableIroh: true },
            createIrohTransport: async (onStatusChange) => {
                publish = onStatusChange;
                return transport;
            },
            identity,
            irohSecretKeyPath: "unused",
            onStatusChange: changed,
        });

        publish({
            ...initial,
            peers: [{ address: "remote-address", peerId, status: "connected" }],
        });
        expect(network.status().transports[0]).toMatchObject({
            peers: [{ address: "remote-address", peerId, status: "connected" }],
        });
        await network.close();
        expect(close).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalled();
    });
});
