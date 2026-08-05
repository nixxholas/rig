import type { Duplex } from "node:stream";

import type { ConfigP2pPeer } from "../config/types.js";
import { createNodeFrameDuplex } from "./NodeFrameDuplex.js";
import {
    readP2pHttpRequest,
    writeP2pHttpFailure,
    writeP2pHttpResponse,
} from "./P2pFrameProtocol.js";
import { readBytes, writeBytes, type P2pFrameDuplex } from "./P2pFrameDuplex.js";
import { runP2pResponderHello } from "./P2pHelloProtocol.js";
import type { ServeP2pHttpRequest } from "./P2pHttp.js";
import type { P2pInstanceIdentity, P2pPeerIdentity } from "./P2pIdentity.js";
import {
    readSshBridgePreface,
    sshChannelBinding,
    SSH_OPERATION_HTTP,
    SSH_OPERATION_PING,
} from "./SshTransport.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_HEAD_TIMEOUT_MS = 30_000;
const MAXIMUM_BRIDGES = 32;

export interface CreateSshBridgeResponderOptions {
    commitPeer?: (identity: P2pPeerIdentity, binding: string) => Promise<void>;
    identity: P2pInstanceIdentity;
    peers: readonly ConfigP2pPeer[];
    serveRequest: ServeP2pHttpRequest;
    validatePeer?: (identity: P2pPeerIdentity, binding: string) => Promise<void>;
}

export class SshBridgeResponder {
    readonly #active = new Set<Duplex>();
    readonly #options: CreateSshBridgeResponderOptions;
    readonly #peers = new Map<string, ConfigP2pPeer>();

    constructor(options: CreateSshBridgeResponderOptions) {
        this.#options = options;
        for (const peer of options.peers) this.#peers.set(peer.instanceId, peer);
    }

    async accept(stream: Duplex): Promise<void> {
        if (this.#active.size >= MAXIMUM_BRIDGES) {
            stream.destroy();
            throw new Error("The SSH P2P bridge has reached its connection limit.");
        }
        this.#active.add(stream);
        const duplex = createNodeFrameDuplex(stream, stream);
        const controller = new AbortController();
        stream.once("close", () => controller.abort());
        try {
            await this.acceptFrames(duplex, controller.signal);
            stream.end();
        } catch (error) {
            stream.destroy();
            throw error;
        } finally {
            controller.abort();
            this.#active.delete(stream);
        }
    }

    /** Serves one bridge over an already established framed duplex. */
    async acceptFrames(duplex: P2pFrameDuplex, signal?: AbortSignal): Promise<void> {
        const hostKeyHash = await withDeadline(
            readSshBridgePreface(duplex.recv),
            HANDSHAKE_TIMEOUT_MS,
            "The SSH P2P bridge did not send its channel binding in time.",
        );
        const channelBinding = sshChannelBinding(hostKeyHash);
        const identity = await withDeadline(
            runP2pResponderHello(duplex, {
                commitPeer: (peerIdentity) =>
                    this.#options.commitPeer?.(peerIdentity, peerIdentity.publicKey) ??
                    Promise.resolve(),
                identity: this.#options.identity,
                localChannelBinding: channelBinding,
                remoteChannelBinding: channelBinding,
                transport: "ssh",
                validatePeer: (peerIdentity) =>
                    this.#validatePeer(peerIdentity, peerIdentity.publicKey),
            }),
            HANDSHAKE_TIMEOUT_MS,
            "The SSH P2P peer did not finish its signed hello in time.",
        );
        const operation = (
            await withDeadline(
                readBytes(duplex.recv, 1),
                HANDSHAKE_TIMEOUT_MS,
                "The SSH P2P peer did not choose an operation in time.",
            )
        )[0];
        if (operation === SSH_OPERATION_PING) {
            await writeBytes(duplex.send, Uint8Array.of(SSH_OPERATION_PING));
            return;
        }
        if (operation !== SSH_OPERATION_HTTP) throw new Error("Unknown SSH P2P operation.");
        await this.#serveHttp(duplex, identity.instanceId, signal);
    }

    close(): void {
        for (const stream of this.#active) stream.destroy();
        this.#active.clear();
    }

    async #serveHttp(
        duplex: P2pFrameDuplex,
        peerId: string,
        outerSignal?: AbortSignal,
    ): Promise<void> {
        const controller = new AbortController();
        const abort = () => controller.abort();
        outerSignal?.addEventListener("abort", abort, { once: true });
        try {
            const request = await withDeadline(
                readP2pHttpRequest(duplex.recv),
                REQUEST_TIMEOUT_MS,
                "The SSH P2P peer did not finish its request in time.",
            );
            const response = await withDeadline(
                this.#options.serveRequest(peerId, request, controller.signal),
                RESPONSE_HEAD_TIMEOUT_MS,
                "The local daemon did not return response headers in time.",
            );
            await writeP2pHttpResponse(duplex.send, response);
        } catch (error) {
            if (!controller.signal.aborted) {
                await writeP2pHttpFailure(duplex.send, error).catch(() => undefined);
            }
        } finally {
            controller.abort();
            outerSignal?.removeEventListener("abort", abort);
        }
    }

    async #validatePeer(identity: P2pPeerIdentity, binding: string): Promise<void> {
        const expected = this.#peers.get(identity.instanceId);
        if (expected === undefined || expected.publicKey !== identity.publicKey) {
            throw new Error("The SSH P2P peer identity does not match its allowlist.");
        }
        await this.#options.validatePeer?.(identity, binding);
    }
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        void promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
