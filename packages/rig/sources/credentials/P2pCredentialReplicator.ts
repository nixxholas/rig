import { createHash } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { withWorkerContext } from "../observability/index.js";

import type { P2pNetwork } from "../p2p/index.js";
import {
    p2pCredentialReplaceResponseSchema,
    p2pCredentialVersionConflictResponseSchema,
    type P2pCredentialSnapshot,
    type P2pEncryptedCredentialSnapshot,
} from "../protocol/P2pCredentialProtocol.js";
import type { P2pCredentialStore } from "./P2pCredentialStore.js";

const REQUEST_TIMEOUT_MS = 20_000;
const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_VERSION_RECONCILIATIONS = 3;
// Native providers begin refreshing five minutes before expiry. Checking one minute sooner keeps
// an unattended remote session supplied without polling aggressively.
const LEASE_RENEWAL_INTERVAL_MS = 4 * 60 * 1_000;

export interface P2pCredentialReplicatorOptions {
    listPeers: (
        ctx: Context,
    ) =>
        | readonly { instanceId: string; publicKey: string }[]
        | Promise<readonly { instanceId: string; publicKey: string }[]>;
    network: P2pNetwork;
    onError?: (ctx: Context, peerId: string, error: unknown) => void;
    snapshot: (ctx: Context) => P2pCredentialSnapshot | Promise<P2pCredentialSnapshot>;
    store: P2pCredentialStore;
}

/** Synchronizes this Rig's complete credential snapshot to each trusted peer. */
export class P2pCredentialReplicator {
    readonly #abort = new AbortController();
    readonly #inFlight = new Map<string, Promise<void>>();
    readonly #options: P2pCredentialReplicatorOptions;
    #renewalRun: Promise<void> | undefined;
    #renewalTimer: ReturnType<typeof setTimeout> | undefined;
    #snapshotInFlight: Promise<P2pCredentialSnapshot> | undefined;
    readonly #synchronizedDigests = new Map<string, string>();

    constructor(options: P2pCredentialReplicatorOptions) {
        this.#options = options;
        this.#scheduleLeaseRenewal();
    }

    ensure(ctx: Context, peerId: string, signal?: AbortSignal): Promise<void> {
        if (this.#abort.signal.aborted) {
            return Promise.reject(new Error("Credential synchronization is closed."));
        }
        const current = this.#inFlight.get(peerId);
        if (current !== undefined) return current;
        const run = this.#synchronize(ctx, peerId, signal).finally(() => {
            if (this.#inFlight.get(peerId) === run) this.#inFlight.delete(peerId);
        });
        this.#inFlight.set(peerId, run);
        return run;
    }

    /** Reports an optional credential preflight failure without failing the proxied request. */
    async ensureForRequest(ctx: Context, peerId: string, signal?: AbortSignal): Promise<void> {
        try {
            await this.ensure(ctx, peerId, signal);
        } catch (error) {
            this.#report(ctx, peerId, error);
        }
    }

    peerChanged(ctx: Context, peerId: string): Promise<void> {
        this.#synchronizedDigests.delete(peerId);
        return this.ensureForRequest(ctx, peerId);
    }

    async syncAll(ctx: Context): Promise<void> {
        await Promise.all(
            (await this.#options.listPeers(ctx)).map((peer) =>
                this.peerChanged(ctx, peer.instanceId),
            ),
        );
    }

    async close(_ctx: Context): Promise<void> {
        if (this.#abort.signal.aborted) return;
        this.#abort.abort();
        if (this.#renewalTimer !== undefined) clearTimeout(this.#renewalTimer);
        this.#renewalTimer = undefined;
        await this.#renewalRun?.catch(() => undefined);
        await Promise.allSettled(this.#inFlight.values());
    }

    #scheduleLeaseRenewal(): void {
        if (
            this.#abort.signal.aborted ||
            this.#renewalTimer !== undefined ||
            this.#renewalRun !== undefined
        ) {
            return;
        }
        this.#renewalTimer = setTimeout(() => {
            this.#renewalTimer = undefined;
            const run = withWorkerContext("p2p-credential-renewal", (ctx) =>
                this.#renewLeases(ctx),
            );
            this.#renewalRun = run;
            const finish = (): void => {
                if (this.#renewalRun === run) this.#renewalRun = undefined;
                this.#scheduleLeaseRenewal();
            };
            void run.then(finish, finish);
        }, LEASE_RENEWAL_INTERVAL_MS);
        this.#renewalTimer.unref?.();
    }

    async #renewLeases(ctx: Context): Promise<void> {
        try {
            await Promise.all(
                (await this.#options.listPeers(ctx)).map((peer) =>
                    this.ensureForRequest(ctx, peer.instanceId),
                ),
            );
        } catch (error) {
            this.#report(ctx, "local", error);
        }
    }

    #report(ctx: Context, peerId: string, error: unknown): void {
        try {
            this.#options.onError?.(ctx, peerId, error);
        } catch {
            // Optional replication and diagnostics cannot interrupt proxying or renewal.
        }
    }

    async #synchronize(ctx: Context, peerId: string, signal?: AbortSignal): Promise<void> {
        const peer = (await this.#options.listPeers(ctx)).find(
            (candidate) => candidate.instanceId === peerId,
        );
        if (peer === undefined) throw new Error("That Rig is not a trusted P2P peer.");
        let snapshot = await this.#snapshot(ctx);
        const timeout = new AbortController();
        const timeoutTimer = setTimeout(
            () =>
                timeout.abort(
                    new DOMException("Credential synchronization timed out.", "TimeoutError"),
                ),
            REQUEST_TIMEOUT_MS,
        );
        timeoutTimer.unref?.();
        const requestSignal = AbortSignal.any([
            this.#abort.signal,
            ...(signal === undefined ? [] : [signal]),
            timeout.signal,
        ]);
        try {
            for (
                let reconciliation = 0;
                reconciliation <= MAXIMUM_VERSION_RECONCILIATIONS;
                reconciliation += 1
            ) {
                const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
                if (this.#synchronizedDigests.get(peerId) === digest) return;
                const envelope = this.#options.store.encryptForPeer(snapshot, peer.publicKey);
                const { response } = await this.#options.network.fetch(
                    ctx,
                    peerId,
                    {
                        body: Buffer.from(JSON.stringify(envelope), "utf8"),
                        headers: { accept: "application/json", "content-type": "application/json" },
                        method: "PUT",
                        path: "/inference-credentials",
                    },
                    requestSignal,
                );
                const body = await collectJson(response.body);
                if (response.status === 200) {
                    if (
                        !Value.Check(p2pCredentialReplaceResponseSchema, body) ||
                        body.version !== snapshot.version
                    ) {
                        throw new Error(
                            "The remote Rig returned an invalid credential synchronization response.",
                        );
                    }
                    this.#synchronizedDigests.set(peerId, digest);
                    return;
                }
                if (
                    response.status === 409 &&
                    Value.Check(p2pCredentialVersionConflictResponseSchema, body) &&
                    reconciliation < MAXIMUM_VERSION_RECONCILIATIONS
                ) {
                    snapshot = await this.#options.store.fastForwardOwnSnapshot(
                        ctx,
                        snapshot,
                        body.version,
                    );
                    continue;
                }
                throw new Error(
                    `The remote Rig rejected inference credentials with status ${String(response.status)}.`,
                );
            }
            throw new Error("The remote Rig repeatedly rejected the credential snapshot version.");
        } finally {
            clearTimeout(timeoutTimer);
        }
    }

    #snapshot(ctx: Context): Promise<P2pCredentialSnapshot> {
        if (this.#snapshotInFlight !== undefined) return this.#snapshotInFlight;
        const pending = Promise.resolve(this.#options.snapshot(ctx)).finally(() => {
            if (this.#snapshotInFlight === pending) this.#snapshotInFlight = undefined;
        });
        this.#snapshotInFlight = pending;
        return pending;
    }
}

export async function replicateCredentialSnapshotToP2pPeer(
    ctx: Context,
    options: {
        envelope: P2pEncryptedCredentialSnapshot;
        network: P2pNetwork;
        peerId: string;
        signal: AbortSignal;
    },
): Promise<void> {
    const { response } = await options.network.fetch(
        ctx,
        options.peerId,
        {
            body: Buffer.from(JSON.stringify(options.envelope), "utf8"),
            headers: { accept: "application/json", "content-type": "application/json" },
            method: "PUT",
            path: "/inference-credentials",
        },
        options.signal,
    );
    const body = await collectJson(response.body);
    if (response.status !== 200 || !Value.Check(p2pCredentialReplaceResponseSchema, body)) {
        throw new Error(
            `The remote Rig rejected inference credentials with status ${String(response.status)}.`,
        );
    }
}

async function collectJson(body: AsyncIterable<Uint8Array>): Promise<unknown> {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
        bytes += chunk.byteLength;
        if (bytes > MAXIMUM_RESPONSE_BYTES) {
            throw new Error("The remote Rig returned an oversized credential response.");
        }
        chunks.push(Buffer.from(chunk));
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new Error("The remote Rig returned invalid credential response JSON.");
    }
}
