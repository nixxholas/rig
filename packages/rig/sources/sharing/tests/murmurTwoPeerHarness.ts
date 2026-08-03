/**
 * Two Rig daemons talking over one in-memory relay with real signed Murmur events.
 *
 * Every kind of share rides the same transport, so both the session and the scope
 * two-peer tests drive the same harness rather than each keeping its own copy of
 * the sync loop that makes replication deterministic.
 */
import {
    createPrivateMessage,
    encryptPrivateMessageForContact,
    generateIdentityKeyPair,
    identityId,
    identityInboxTopic,
    MemoryMurmurStore,
    MurmurClient,
    type IdentityKeyPair,
    type MurmurStore,
    type ReceivedEvent,
} from "@slopus/murmur";

import { encodeMurmurIdentityToken } from "../../murmur/impl/identityToken.js";
import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";
import type {
    MurmurEventRouter,
    MurmurRuntimeHandle,
    MurmurServiceContract,
} from "../../murmur/types.js";
import type { MurmurFriendship, MurmurProfile } from "../../protocol/MurmurProtocol.js";

export interface Peer {
    readonly client: MurmurClient;
    readonly identity: IdentityKeyPair;
    readonly peerId: string;
    readonly store: MurmurStore;
}

export async function createPeer(relay: InMemoryMurmurRelay): Promise<Peer> {
    const identity = generateIdentityKeyPair();
    const store = new MemoryMurmurStore();
    const client = new MurmurClient({ identity, store, transports: [relay.transport("relay")] });
    await client.subscribe(identityInboxTopic(identity));
    return { client, identity, peerId: identityId(identity), store };
}

export function friendship(peer: Peer, profile: MurmurProfile): MurmurFriendship {
    return {
        autoAcceptEligible: false,
        direction: "mutual",
        firstSeenAt: 1_700_000_000_000,
        history: { accepted: 1, autoAccepted: 0, received: 0, rejected: 0, sent: 1 },
        peerId: peer.peerId,
        profile,
        state: "friends",
        token: encodeMurmurIdentityToken(peer.identity),
        updatedAt: 1_700_000_000_000,
        version: "friendship-1",
    };
}

/**
 * A Murmur service driven entirely by the test: the relay carries real signed
 * events, but the sync loop is a `pump()` the test awaits so replication is
 * deterministic. It routes each event exactly as `MurmurService` does — through
 * every registered router first, advancing the cursor itself only when no router
 * claims the event.
 */
export class FakeMurmurService implements MurmurServiceContract {
    readonly #peer: Peer;
    readonly #profile: MurmurProfile;
    readonly #friends: () => readonly MurmurFriendship[];
    readonly #routers = new Set<MurmurEventRouter>();
    readonly #runtimeListeners = new Set<(runtime: MurmurRuntimeHandle | undefined) => void>();

    constructor(peer: Peer, profile: MurmurProfile, friends: () => readonly MurmurFriendship[]) {
        this.#peer = peer;
        this.#profile = profile;
        this.#friends = friends;
    }

    runtime(): MurmurRuntimeHandle {
        return {
            client: this.#peer.client,
            identity: this.#peer.identity,
            store: this.#peer.store,
        };
    }

    onRuntimeChanged(listener: (runtime: MurmurRuntimeHandle | undefined) => void): () => void {
        this.#runtimeListeners.add(listener);
        return () => {
            this.#runtimeListeners.delete(listener);
        };
    }

    registerEventRouter(router: MurmurEventRouter): () => void {
        this.#routers.add(router);
        return () => {
            this.#routers.delete(router);
        };
    }

    async getAccount() {
        return {
            account: {
                id: this.#peer.peerId,
                profile: this.#profile,
                token: encodeMurmurIdentityToken(this.#peer.identity),
            },
            service: { relayUrls: [], status: "running" as const },
        };
    }

    async getFriends() {
        return {
            contacts: [],
            friendships: [...this.#friends()],
            service: { relayUrls: [], status: "running" as const },
            stats: {
                acceptedRequests: 0,
                autoAcceptedRequests: 0,
                contacts: 0,
                incomingPending: 0,
                outgoingPending: 0,
                rejectedRequests: 0,
            },
        };
    }

    /** Re-announce the live runtime so the runtime recovers owner shares and retries them. */
    announceRuntime(): void {
        for (const listener of this.#runtimeListeners) listener(this.runtime());
    }

    /** Drain every queued event into the registered routers until nothing advances. */
    async pump(): Promise<void> {
        let previous = "";
        for (let round = 0; round < 40; round += 1) {
            const result = await this.#peer.client.sync(0);
            if (result.status === "reset") continue;
            if (result.events.length === 0) return;
            for (const received of result.events) {
                // A router that owns an event but is not ready for it yet keeps the topic cursor
                // where it is, so no later event on that topic may advance until a retry replays
                // it. Stop this pass at that point and let the next round re-read from the cursor.
                if (!(await this.#route(received))) return;
            }
            // All-retained rounds re-read the same events forever; stop once a pass adds nothing.
            const cursor = result.events.map((event) => String(event.seq)).join(",");
            if (cursor === previous) return;
            previous = cursor;
        }
    }

    /** Route one event, returning whether the cursor is free to continue past it. */
    async #route(received: ReceivedEvent): Promise<boolean> {
        for (const router of this.#routers) {
            const outcome = await router(received);
            // `retained` means the owning router deliberately left the cursor where it is,
            // exactly as `MurmurService` treats it: the pass stops rather than advancing.
            if (outcome === "retained") return false;
            if (outcome === "applied") return true;
        }
        try {
            await this.#peer.store.transaction(async (transaction) => {
                await received.advanceCursor(transaction);
            });
        } catch (error: unknown) {
            if (error instanceof Error && error.message.startsWith("Cannot advance Murmur topic")) {
                return false;
            }
            throw error;
        }
        return true;
    }

    signup(): never {
        throw new Error("unused");
    }
    start(): never {
        throw new Error("unused");
    }
    stop(): never {
        throw new Error("unused");
    }
    deleteAccount(): never {
        throw new Error("unused");
    }
    sendFriendRequest(): never {
        throw new Error("unused");
    }
    listFriendRequests(): never {
        throw new Error("unused");
    }
    answerFriendRequest(): never {
        throw new Error("unused");
    }
    listContacts(): never {
        throw new Error("unused");
    }
    close(): never {
        throw new Error("unused");
    }
}

/** Let a runtime's fire-and-forget offers, joins, and publishes reach the relay. */
export function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Pump every peer, optionally driving a side effect each round, until the condition
 * holds. The bounded rounds keep the test deterministic and fast.
 */
export async function pumpUntil(
    services: readonly FakeMurmurService[],
    condition: () => boolean | Promise<boolean>,
): Promise<void> {
    for (let round = 0; round < 40; round += 1) {
        await settle();
        for (const service of services) await service.pump();
        await settle();
        if (await condition()) return;
    }
    throw new Error("The two-peer sharing condition was never reached.");
}
