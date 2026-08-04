import { describe, expect, it, vi } from "vitest";

import type { P2pTransport } from "./P2pTransport.js";
import { P2pNetwork } from "./P2pNetwork.js";

const disabledConfig = {
    enableIroh: false,
    iroh: { trustedEndpointIds: [] },
} as const;

describe("P2pNetwork", () => {
    it("starts with no transports when all transports are disabled", async () => {
        const network = await P2pNetwork.create({
            config: disabledConfig,
            irohSecretKeyPath: "unused",
        });

        expect(network.status()).toEqual({ transports: [] });
        await network.close();
    });

    it("contains one transport failure without failing the P2P service", async () => {
        const unavailable = vi.fn();
        const network = await P2pNetwork.create({
            config: { ...disabledConfig, enableIroh: true },
            createIrohTransport: async () => {
                throw new Error("binding unavailable");
            },
            irohSecretKeyPath: "unused",
            onTransportUnavailable: unavailable,
        });

        expect(network.status()).toEqual({
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
        let publish!: (status: ReturnType<P2pTransport["status"]>) => void;
        const initial: ReturnType<P2pTransport["status"]> = {
            localId: "local",
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
            irohSecretKeyPath: "unused",
            onStatusChange: changed,
        });

        publish({
            ...initial,
            peers: [{ peerId: "remote", status: "connected" }],
        });
        expect(network.status().transports[0]).toMatchObject({
            peers: [{ peerId: "remote", status: "connected" }],
        });
        await network.close();
        expect(close).toHaveBeenCalledOnce();
        expect(changed).toHaveBeenCalled();
    });
});
