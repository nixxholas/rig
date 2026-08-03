import {
    generateIdentityKeyPair,
    identityId,
    identityInboxTopic,
    MemoryMurmurStore,
    MurmurClient,
    type IdentityKeyPair,
    type MurmurStore,
    type ReceivedEvent,
} from "@slopus/murmur";
import { afterEach, describe, expect, it } from "vitest";

import { encodeMurmurIdentityToken } from "../../murmur/impl/identityToken.js";
import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";
import type {
    MurmurEventRouter,
    MurmurRuntimeHandle,
    MurmurServiceContract,
} from "../../murmur/types.js";
import type { MurmurFriendship, MurmurProfile } from "../../protocol/MurmurProtocol.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createSessionShareRuntime } from "../createSessionShareRuntime.js";

interface Peer {
    readonly client: MurmurClient;
    readonly identity: IdentityKeyPair;
    readonly peerId: string;
    readonly store: MurmurStore;
}

async function createPeer(relay: InMemoryMurmurRelay): Promise<Peer> {
    const identity = generateIdentityKeyPair();
    const store = new MemoryMurmurStore();
    const client = new MurmurClient({ identity, store, transports: [relay.transport("relay")] });
    await client.subscribe(identityInboxTopic(identity));
    return { client, identity, peerId: identityId(identity), store };
}

function friendship(peer: Peer, profile: MurmurProfile): MurmurFriendship {
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
class FakeMurmurService implements MurmurServiceContract {
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
            if (await router(received)) return true;
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

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Let the runtime's fire-and-forget offers, joins, and publishes reach the relay. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("session sharing between two peers over the real Murmur transport", () => {
    it("shares a session, replicates entries, carries a friend message back, and ends on stop", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const friend = await createPeer(relay);

        // The friend's Murmur profile name is deliberately different from the name the owner
        // registers when inviting them, so an accepted friend message proves the owner labels it
        // with its own registered name rather than anything the network supplied.
        const ownerProfile: MurmurProfile = { firstName: "Dana", lastName: "Owner" };
        const friendProfile: MurmurProfile = { firstName: "Robin", lastName: "Networks" };
        const registeredName = "Blossom (owner-chosen)";

        const ownerMurmur = new FakeMurmurService(owner, ownerProfile, () => [
            friendship(friend, friendProfile),
        ]);
        const friendMurmur = new FakeMurmurService(friend, friendProfile, () => [
            friendship(owner, ownerProfile),
        ]);

        const storeOwner = new PersistentSessionStore({ databasePath: ":memory:" });
        const storeFriend = new PersistentSessionStore({ databasePath: ":memory:" });
        cleanups.push(() => storeOwner.close());
        cleanups.push(() => storeFriend.close());

        const delivered: { displayName: string | undefined; text: string }[] = [];
        const ownerRuntime = createSessionShareRuntime({
            daemonStore: storeOwner.sessionShareDaemonStore,
            deliverFriendMessage: (_ownerSessionId, message) => {
                delivered.push({
                    displayName: message.friendAuthor?.displayName,
                    text: message.blocks
                        .map((block) => ("text" in block ? block.text : ""))
                        .join(""),
                });
            },
            murmur: ownerMurmur,
            shareStore: storeOwner.sessionShares,
        });
        const friendRuntime = createSessionShareRuntime({
            daemonStore: storeFriend.sessionShareDaemonStore,
            deliverFriendMessage: () => {},
            murmur: friendMurmur,
            shareStore: storeFriend.sessionShares,
        });
        cleanups.push(() => void ownerRuntime.close());
        cleanups.push(() => void friendRuntime.close());

        const ownerSessionId = storeOwner.create({ cwd: "/tmp/two-peers-owner" }).id;
        storeOwner.upsertMessage(ownerSessionId, {
            isPartial: false,
            message: {
                blocks: [{ text: "Looking at the failing test.", type: "text" }],
                id: "owner-entry-1",
                role: "user",
            },
            position: 0,
        });
        storeOwner.upsertMessage(ownerSessionId, {
            isPartial: false,
            message: {
                blocks: [{ text: "Found the cause.", type: "text" }],
                id: "owner-entry-2",
                role: "user",
            },
            position: 1,
        });

        // Each runtime offers a one-use key package to its friend when it starts. If the owner's
        // first invite races ahead of that offer, the transport asks the friend for a fresh one and
        // the retried create completes it — both are ordinary, so create is driven to success.
        let created!: Awaited<ReturnType<typeof ownerRuntime.contract.create>>;
        await pumpUntil([ownerMurmur, friendMurmur], async () => {
            try {
                created = await ownerRuntime.contract.create(ownerSessionId, {
                    friends: [{ displayName: registeredName, peerId: friend.peerId }],
                    includeFriendMessagesInModel: true,
                    mutationId: "mutation-create",
                });
                return created.share.state === "active";
            } catch {
                return false;
            }
        });
        expect(created.share).toMatchObject({ memberCount: 1, state: "active" });
        expect(created.members).toMatchObject([
            { displayName: registeredName, murmurPeerId: friend.peerId, state: "active" },
        ]);
        const shareId = created.share.shareId;

        // The friend receives the invitation, joins, and catches up the owner's two entries.
        // Nothing here re-announces the owner's runtime or wakes the share: joining has to
        // backfill history on its own, or a member never sees a transcript that predates it.
        await pumpUntil([ownerMurmur, friendMurmur], () => {
            const history = friendRuntime.contract.replicaHistory(shareId);
            return history !== undefined && history.entries.length >= 2;
        });

        const replica = friendRuntime.contract
            .listReplicas()
            .replicas.find((candidate) => candidate.grant.shareId === shareId);
        expect(replica).toBeDefined();
        expect(replica).toMatchObject({ ownerPeerId: owner.peerId, state: "active" });

        const history = friendRuntime.contract.replicaHistory(shareId)!;
        expect(history.entries.map((entry) => entry.shareSequence)).toEqual([1, 2]);
        const ownerEntries = storeOwner.sessionShares.queryEntryPage(shareId, {
            afterSequence: 0,
            maxBytes: 1 << 20,
            maxItems: 100,
        });
        expect(history.entries.map((entry) => entry.canonicalJson)).toEqual(
            ownerEntries.entries.map((entry) => entry.canonicalJson),
        );

        // The friend posts a message; the owner must accept it durably and label it with the
        // name it registered, not the friend's Murmur profile name.
        await friendRuntime.contract.postFriendMessage({
            clientMessageId: "friend-post-1",
            grant: replica!.grant,
            text: "Try clearing the cache first.",
        });
        await pumpUntil([friendMurmur, ownerMurmur], () => delivered.length >= 1);

        expect(delivered).toEqual([
            { displayName: registeredName, text: "Try clearing the cache first." },
        ]);
        expect(delivered[0]!.displayName).not.toBe("Robin Networks");

        // Stopping the share retires the friend's replica.
        await ownerRuntime.contract.stop(ownerSessionId, { mutationId: "mutation-stop" });
        await pumpUntil([ownerMurmur, friendMurmur], () => {
            const current = friendRuntime.contract
                .listReplicas()
                .replicas.find((candidate) => candidate.grant.shareId === shareId);
            return current?.state === "ended";
        });

        const ended = friendRuntime.contract
            .listReplicas()
            .replicas.find((candidate) => candidate.grant.shareId === shareId);
        expect(ended?.state).toBe("ended");
    }, 30_000);

    it("catches a late member up with the transcript that already exists", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = await createPeer(relay);
        const early = await createPeer(relay);
        const late = await createPeer(relay);

        const ownerProfile: MurmurProfile = { firstName: "Dana", lastName: "Owner" };
        const earlyProfile: MurmurProfile = { firstName: "Robin", lastName: "First" };
        const lateProfile: MurmurProfile = { firstName: "Sam", lastName: "Later" };

        const ownerMurmur = new FakeMurmurService(owner, ownerProfile, () => [
            friendship(early, earlyProfile),
            friendship(late, lateProfile),
        ]);
        const earlyMurmur = new FakeMurmurService(early, earlyProfile, () => [
            friendship(owner, ownerProfile),
        ]);
        const lateMurmur = new FakeMurmurService(late, lateProfile, () => [
            friendship(owner, ownerProfile),
        ]);

        const ownerHost = createHost(ownerMurmur);
        createHost(earlyMurmur);
        const lateHost = createHost(lateMurmur);

        const ownerSessionId = ownerHost.store.create({ cwd: "/tmp/late-member-owner" }).id;
        for (const [position, text] of ["First finding.", "Second finding."].entries()) {
            ownerHost.store.upsertMessage(ownerSessionId, {
                isPartial: false,
                message: {
                    blocks: [{ text, type: "text" }],
                    id: `entry-${position}`,
                    role: "user",
                },
                position,
            });
        }

        await pumpUntil([ownerMurmur, earlyMurmur, lateMurmur], async () => {
            try {
                const created = await ownerHost.runtime.contract.create(ownerSessionId, {
                    friends: [{ displayName: "Robin", peerId: early.peerId }],
                    includeFriendMessagesInModel: true,
                    mutationId: "mutation-create-late",
                });
                return created.share.state === "active";
            } catch {
                return false;
            }
        });
        const shareId = ownerHost.runtime.contract.getOwner(ownerSessionId)!.share.shareId;
        const published = ownerHost.store.sessionShares.queryEntryPage(shareId, {
            afterSequence: 0,
            maxBytes: 1 << 20,
            maxItems: 100,
        });
        expect(published.entries.length).toBeGreaterThanOrEqual(2);

        // The late friend is invited only now, after the whole transcript is already
        // committed to the group. Everything it must ever see is history.
        await pumpUntil([ownerMurmur, lateMurmur], async () => {
            try {
                await ownerHost.runtime.contract.add(ownerSessionId, {
                    friend: { displayName: "Sam", peerId: late.peerId },
                    mutationId: "mutation-add-late",
                });
                return true;
            } catch {
                return false;
            }
        });

        await pumpUntil([ownerMurmur, lateMurmur], () => {
            const history = lateHost.runtime.contract.replicaHistory(shareId);
            return history !== undefined && history.entries.length >= published.entries.length;
        });

        const history = lateHost.runtime.contract.replicaHistory(shareId)!;
        expect(history.entries.map((entry) => entry.canonicalJson)).toEqual(
            published.entries.map((entry) => entry.canonicalJson),
        );
    }, 30_000);
});

/** One Rig daemon's worth of session-sharing state for a peer. */
function createHost(murmur: FakeMurmurService): {
    runtime: ReturnType<typeof createSessionShareRuntime>;
    store: PersistentSessionStore;
} {
    const store = new PersistentSessionStore({ databasePath: ":memory:" });
    const runtime = createSessionShareRuntime({
        daemonStore: store.sessionShareDaemonStore,
        deliverFriendMessage: () => {},
        murmur,
        shareStore: store.sessionShares,
    });
    cleanups.push(() => store.close());
    cleanups.push(() => void runtime.close());
    return { runtime, store };
}

/**
 * Pump both peers, optionally driving a side effect each round, until the
 * condition holds. The bounded rounds keep the test deterministic and fast.
 */
async function pumpUntil(
    services: readonly FakeMurmurService[],
    condition: () => boolean | Promise<boolean>,
): Promise<void> {
    for (let round = 0; round < 40; round += 1) {
        await settle();
        for (const service of services) await service.pump();
        await settle();
        if (await condition()) return;
    }
    throw new Error("The two-peer session-sharing condition was never reached.");
}
