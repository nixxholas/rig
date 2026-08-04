import type { RecvStream, SendStream } from "@number0/iroh/index.js";
import { describe, expect, it, vi } from "vitest";

import {
    createIrohHelloFinish,
    createIrohHelloProof,
    runIrohInitiatorHello,
    runIrohResponderHello,
    verifyIrohHelloFinish,
    verifyIrohHelloProof,
    type IrohHelloContext,
} from "./IrohHelloProtocol.js";
import { createP2pInstanceIdentity } from "./P2pIdentity.js";

const INITIATOR_ENDPOINT = "1".repeat(64);
const RESPONDER_ENDPOINT = "2".repeat(64);
const NOW = 1_800_000_000_000;

describe("signed Iroh hello", () => {
    it("mutually proves stable identities and binds them to the live endpoint IDs", async () => {
        const initiator = createP2pInstanceIdentity();
        const responder = createP2pInstanceIdentity();
        const wire = duplexPair();
        const verifyInitiator = vi.fn(async () => undefined);
        const verifyResponder = vi.fn(async () => undefined);

        const [seenResponder, seenInitiator] = await Promise.all([
            runIrohInitiatorHello(wire.left.recv, wire.left.send, {
                identity: initiator,
                localEndpointId: INITIATOR_ENDPOINT,
                now: () => NOW,
                randomNonce: () => "a".repeat(43),
                remoteEndpointId: RESPONDER_ENDPOINT,
                commitPeer: verifyResponder,
            }),
            runIrohResponderHello(wire.right.recv, wire.right.send, {
                identity: responder,
                localEndpointId: RESPONDER_ENDPOINT,
                now: () => NOW,
                randomNonce: () => "b".repeat(43),
                remoteEndpointId: INITIATOR_ENDPOINT,
                commitPeer: verifyInitiator,
            }),
        ]);

        expect(seenResponder).toEqual({
            instanceId: responder.instanceId,
            publicKey: responder.publicKey,
        });
        expect(seenInitiator).toEqual({
            instanceId: initiator.instanceId,
            publicKey: initiator.publicKey,
        });
        expect(verifyInitiator).toHaveBeenCalledWith(seenInitiator, INITIATOR_ENDPOINT);
        expect(verifyResponder).toHaveBeenCalledWith(seenResponder, RESPONDER_ENDPOINT);
    });

    it("rejects a proof replayed with fresh nonces or different endpoint IDs", () => {
        const identity = createP2pInstanceIdentity();
        const context: IrohHelloContext = {
            initiatorEndpointId: INITIATOR_ENDPOINT,
            initiatorNonce: "a".repeat(43),
            responderEndpointId: RESPONDER_ENDPOINT,
            responderNonce: "b".repeat(43),
        };
        const proof = createIrohHelloProof(identity, "responder", context, NOW);

        expect(() =>
            verifyIrohHelloProof(
                proof,
                "responder",
                { ...context, responderNonce: "c".repeat(43) },
                NOW,
            ),
        ).toThrow("another connection");
        expect(() =>
            verifyIrohHelloProof(
                proof,
                "responder",
                { ...context, responderEndpointId: "3".repeat(64) },
                NOW,
            ),
        ).toThrow("another connection");
    });

    it("binds the responder's finish to the initiator identity it accepted", () => {
        const initiator = createP2pInstanceIdentity();
        const substitutedInitiator = createP2pInstanceIdentity();
        const responder = createP2pInstanceIdentity();
        const context: IrohHelloContext = {
            initiatorEndpointId: INITIATOR_ENDPOINT,
            initiatorNonce: "a".repeat(43),
            responderEndpointId: RESPONDER_ENDPOINT,
            responderNonce: "b".repeat(43),
        };
        const finish = createIrohHelloFinish(responder, initiator, context);

        expect(() => verifyIrohHelloFinish(finish, responder, initiator, context)).not.toThrow();
        expect(() =>
            verifyIrohHelloFinish(finish, responder, substitutedInitiator, context),
        ).toThrow("did not confirm");
    });

    it("rejects expired, future-dated, and incorrectly signed claims", () => {
        const identity = createP2pInstanceIdentity();
        const context: IrohHelloContext = {
            initiatorEndpointId: INITIATOR_ENDPOINT,
            initiatorNonce: "a".repeat(43),
            responderEndpointId: RESPONDER_ENDPOINT,
            responderNonce: "b".repeat(43),
        };
        const proof = createIrohHelloProof(identity, "initiator", context, NOW);

        expect(() =>
            verifyIrohHelloProof(proof, "initiator", context, NOW + 20 * 60 * 1_000),
        ).toThrow("expired");
        expect(() =>
            verifyIrohHelloProof(proof, "initiator", context, NOW - 10 * 60 * 1_000),
        ).toThrow("clock differs");
        expect(() =>
            verifyIrohHelloProof(
                { ...proof, signature: "z".repeat(86) },
                "initiator",
                context,
                NOW,
            ),
        ).toThrow("could not be verified");
    });

    it("rejects an oversized hello before reading its payload", async () => {
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(8 * 1024 + 1, 0);
        const recv = {
            readExact: vi.fn(async () => [...length]),
        } as unknown as RecvStream;
        const send = {
            finish: async () => undefined,
            writeAll: async () => undefined,
        } as unknown as SendStream;

        await expect(
            runIrohResponderHello(recv, send, {
                identity: createP2pInstanceIdentity(),
                localEndpointId: RESPONDER_ENDPOINT,
                remoteEndpointId: INITIATOR_ENDPOINT,
            }),
        ).rejects.toThrow("invalid P2P hello frame");
        expect(recv.readExact).toHaveBeenCalledOnce();
    });
});

function duplexPair(): {
    left: { recv: RecvStream; send: SendStream };
    right: { recv: RecvStream; send: SendStream };
} {
    const leftToRight = bytePipe();
    const rightToLeft = bytePipe();
    return {
        left: { recv: rightToLeft.recv, send: leftToRight.send },
        right: { recv: leftToRight.recv, send: rightToLeft.send },
    };
}

function bytePipe(): { recv: RecvStream; send: SendStream } {
    const bytes: number[] = [];
    const waiters: (() => void)[] = [];
    const wake = () => waiters.splice(0).forEach((waiter) => waiter());
    return {
        recv: {
            readExact: async (length: number) => {
                while (bytes.length < length) {
                    await new Promise<void>((resolve) => waiters.push(resolve));
                }
                return bytes.splice(0, length);
            },
        } as unknown as RecvStream,
        send: {
            finish: async () => undefined,
            writeAll: async (chunk: number[]) => {
                bytes.push(...chunk);
                wake();
            },
        } as unknown as SendStream,
    };
}
