import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { P2pNetwork } from "../p2p/index.js";
import { p2pInstanceIdSchema } from "../protocol/index.js";
import type { RigProfileStore } from "./RigProfileStore.js";
import {
    P2pProfileReplicationError,
    replicateProfileToP2pPeer,
} from "./replicateProfileForP2pRequest.js";

const INITIAL_RETRY_MS = 1_000;
const MAXIMUM_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAXIMUM_CONFIG_RESPONSE_BYTES = 256 * 1024;
const NON_TARGET_RECHECK_MS = 60_000;
const secondaryConfigResponseSchema = Type.Object({
    config: Type.Object({
        p2p: Type.Object({
            primaryId: p2pInstanceIdSchema,
            role: Type.Literal("secondary"),
        }),
    }),
});

export interface P2pProfileReplicatorOptions {
    listPeerIds: () => readonly string[] | Promise<readonly string[]>;
    localInstanceId: string;
    network: P2pNetwork;
    onError?: (peerId: string, error: unknown) => void;
    profiles: RigProfileStore;
}

/**
 * Keeps local human profiles current on Rigs that name this Rig as their primary.
 *
 * Target discovery intentionally precedes profile bytes: `GET /config` returns
 * 200 over P2P only when the receiving Rig recognizes this peer as its active
 * primary. Other trusted peers therefore learn no profile data.
 */
export class P2pProfileReplicator {
    readonly #abort = new AbortController();
    readonly #listPeerIds: () => readonly string[] | Promise<readonly string[]>;
    readonly #localInstanceId: string;
    readonly #network: P2pNetwork;
    readonly #onError: ((peerId: string, error: unknown) => void) | undefined;
    readonly #pendingProfileVersions = new Map<string, number>();
    readonly #profiles: RigProfileStore;
    readonly #reportedFailures = new Set<string>();
    readonly #retryMissingProfileVersions = new Map<string, number>();
    readonly #syncedVersions = new Map<string, number>();
    readonly #targetCheckedAt = new Map<string, number>();
    readonly #targets = new Map<string, boolean>();
    #retryMs = INITIAL_RETRY_MS;
    #run: Promise<void> | undefined;
    #syncAllRequested = false;
    #timer: ReturnType<typeof setTimeout> | undefined;

    constructor(options: P2pProfileReplicatorOptions) {
        this.#listPeerIds = options.listPeerIds;
        this.#localInstanceId = options.localInstanceId;
        this.#network = options.network;
        this.#onError = options.onError;
        this.#profiles = options.profiles;
    }

    syncProfile(profileId: string, version: number): void {
        if (this.#abort.signal.aborted) return;
        this.#retryMissingProfileVersions.set(
            profileId,
            Math.max(version, this.#retryMissingProfileVersions.get(profileId) ?? 0),
        );
        this.#pendingProfileVersions.set(
            profileId,
            Math.max(version, this.#pendingProfileVersions.get(profileId) ?? 0),
        );
        this.#retryMs = INITIAL_RETRY_MS;
        this.#startNow();
    }

    async profileSynchronized(peerId: string, profileId: string, version: number): Promise<void> {
        if (this.#abort.signal.aborted) return;
        const key = `${peerId}:${profileId}`;
        this.#syncedVersions.set(key, Math.max(version, this.#syncedVersions.get(key) ?? 0));
        this.#reportedFailures.delete(peerId);
        const latest = await this.#profiles.get(profileId);
        if (
            latest !== undefined &&
            (await this.#profiles.isLocal(profileId)) &&
            latest.version > version
        ) {
            this.syncProfile(profileId, latest.version);
        }
    }

    syncAll(options: { recheckTargets?: boolean } = {}): void {
        if (this.#abort.signal.aborted) return;
        if (options.recheckTargets === true) {
            this.#targetCheckedAt.clear();
            this.#targets.clear();
            this.#syncedVersions.clear();
        }
        this.#syncAllRequested = true;
        this.#retryMs = INITIAL_RETRY_MS;
        this.#startNow();
    }

    peerChanged(peerId: string): void {
        this.#targetCheckedAt.delete(peerId);
        this.#targets.delete(peerId);
        for (const key of this.#syncedVersions.keys()) {
            if (key.startsWith(`${peerId}:`)) this.#syncedVersions.delete(key);
        }
        this.syncAll();
    }

    async flush(): Promise<void> {
        await this.#run;
    }

    async close(): Promise<void> {
        if (this.#abort.signal.aborted) return;
        this.#abort.abort();
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#timer = undefined;
        await this.#run?.catch(() => undefined);
    }

    #startNow(): void {
        if (this.#run !== undefined || this.#abort.signal.aborted) return;
        if (this.#timer !== undefined) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
        }
        const run = this.#pass().catch((error: unknown) => {
            this.#report("local", error);
        });
        this.#run = run;
        const finish = (): void => {
            if (this.#run === run) this.#run = undefined;
            if (
                this.#abort.signal.aborted ||
                (this.#pendingProfileVersions.size === 0 && !this.#syncAllRequested)
            ) {
                this.#retryMs = INITIAL_RETRY_MS;
                return;
            }
            this.#scheduleRetry();
        };
        void run.then(finish, finish);
    }

    #scheduleRetry(): void {
        if (this.#timer !== undefined || this.#abort.signal.aborted) return;
        const delay = this.#retryMs;
        this.#retryMs = Math.min(MAXIMUM_RETRY_MS, this.#retryMs * 2);
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#startNow();
        }, delay);
        this.#timer.unref?.();
    }

    async #pass(): Promise<void> {
        if (this.#syncAllRequested) {
            for (const profile of await this.#profiles.list()) {
                if (await this.#profiles.isLocal(profile.id)) {
                    this.#pendingProfileVersions.set(
                        profile.id,
                        Math.max(
                            profile.version,
                            this.#pendingProfileVersions.get(profile.id) ?? 0,
                        ),
                    );
                }
            }
            this.#syncAllRequested = false;
        }
        const peerIds = [...new Set(await this.#listPeerIds())];
        if (peerIds.length === 0) {
            this.#pendingProfileVersions.clear();
            return;
        }
        const pending = new Map(this.#pendingProfileVersions);
        for (const [profileId] of pending) {
            if (this.#abort.signal.aborted) return;
            const profile = await this.#profiles.get(profileId);
            if (profile === undefined || !(await this.#profiles.isLocal(profileId))) {
                this.#pendingProfileVersions.delete(profileId);
                this.#retryMissingProfileVersions.delete(profileId);
                continue;
            }
            let complete = true;
            let missing = false;
            for (const peerId of peerIds) {
                if (this.#abort.signal.aborted) return;
                let target = this.#targets.get(peerId);
                const targetCheckedAt = this.#targetCheckedAt.get(peerId) ?? 0;
                if (
                    target === undefined ||
                    (!target && Date.now() - targetCheckedAt >= NON_TARGET_RECHECK_MS)
                ) {
                    try {
                        target = await this.#isSecondary(peerId);
                        this.#targets.set(peerId, target);
                        this.#targetCheckedAt.set(peerId, Date.now());
                        this.#reportedFailures.delete(peerId);
                    } catch (error) {
                        complete = false;
                        this.#report(peerId, error);
                        continue;
                    }
                }
                if (!target) {
                    continue;
                }
                const key = `${peerId}:${profile.id}`;
                if ((this.#syncedVersions.get(key) ?? 0) >= profile.version) continue;
                try {
                    const result = await replicateProfileToP2pPeer({
                        createIfMissing: false,
                        network: this.#network,
                        peerId,
                        profile,
                        signal: this.#requestSignal(),
                    });
                    if (result === "missing") {
                        missing = true;
                        continue;
                    }
                    this.#syncedVersions.set(key, profile.version);
                    this.#reportedFailures.delete(peerId);
                } catch (error) {
                    if (error instanceof P2pProfileReplicationError && error.status === 403) {
                        this.#targets.set(peerId, false);
                        this.#targetCheckedAt.set(peerId, Date.now());
                        continue;
                    }
                    if (error instanceof P2pProfileReplicationError && error.status === 409) {
                        this.#report(peerId, error);
                        continue;
                    }
                    complete = false;
                    this.#report(peerId, error);
                }
            }
            if (missing && this.#retryMissingProfileVersions.get(profileId) === profile.version) {
                this.#retryMissingProfileVersions.delete(profileId);
                complete = false;
            }
            if (complete && (this.#pendingProfileVersions.get(profileId) ?? 0) <= profile.version) {
                this.#pendingProfileVersions.delete(profileId);
                this.#retryMissingProfileVersions.delete(profileId);
            }
        }
    }

    async #isSecondary(peerId: string): Promise<boolean> {
        const { response } = await this.#network.fetch(
            peerId,
            {
                body: new Uint8Array(),
                headers: { accept: "application/json" },
                method: "GET",
                path: "/config",
            },
            this.#requestSignal(),
        );
        const body = await collect(response.body);
        if (response.status === 200) {
            try {
                const decoded = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
                return (
                    Value.Check(secondaryConfigResponseSchema, decoded) &&
                    decoded.config.p2p.primaryId === this.#localInstanceId
                );
            } catch {
                return false;
            }
        }
        if (response.status === 403) return false;
        throw new Error(`The peer returned ${String(response.status)} while checking its primary.`);
    }

    #requestSignal(): AbortSignal {
        return AbortSignal.any([this.#abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    }

    #report(peerId: string, error: unknown): void {
        if (this.#reportedFailures.has(peerId)) return;
        this.#reportedFailures.add(peerId);
        this.#onError?.(peerId, error);
    }
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of body) {
        bytes += chunk.byteLength;
        if (bytes > MAXIMUM_CONFIG_RESPONSE_BYTES) {
            throw new Error("The peer returned an oversized configuration response.");
        }
        chunks.push(chunk);
    }
    const collected = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        collected.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return collected;
}
