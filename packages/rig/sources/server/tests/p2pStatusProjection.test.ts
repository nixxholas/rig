import { describe, expect, it } from "vitest";

import type { P2pStatus } from "../../protocol/index.js";
import { createP2pStatusChangedEvent } from "../createP2pStatusChangedEvent.js";

describe("P2P API status projection", () => {
    it("publishes the same API-capable peer view in status change events", () => {
        const internalPeerId = "ainternalpeer000000000001";
        const rigPeerId = "arigpeer00000000000000001";
        const status: P2pStatus = {
            name: "Local Rig",
            transports: [
                {
                    apiExposed: true,
                    localAddress: "local-endpoint",
                    peers: [
                        {
                            address: "internal-endpoint",
                            name: "Internal peer",
                            peerId: internalPeerId,
                            status: "connected",
                        },
                        {
                            address: "rig-endpoint",
                            name: "Remote Rig",
                            peerId: rigPeerId,
                            status: "connected",
                        },
                    ],
                    state: "ready",
                    transport: "iroh",
                },
            ],
        };

        const event = createP2pStatusChangedEvent(
            status,
            (peerId) => peerId === rigPeerId,
            "event-id",
            123,
        );

        expect(event).toMatchObject({
            createdAt: 123,
            data: { status: { transports: [{ peers: [{ peerId: rigPeerId }] }] } },
            id: "event-id",
            type: "p2p_status_changed",
        });
        expect(status.transports[0]).toMatchObject({
            peers: [{ peerId: internalPeerId }, { peerId: rigPeerId }],
        });
    });
});
