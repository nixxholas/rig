import { afterEach, describe, expect, it } from "vitest";

import {
    createPeer,
    FakeMurmurService,
    friendship,
    pumpUntil,
    settle,
} from "../../sharing/tests/murmurTwoPeerHarness.js";
import {
    createPrivateMessage,
    encryptPrivateMessageForContact,
    identityInboxTopic,
} from "@slopus/murmur";
import { encodeSharePrivateEnvelope } from "../../sharing/impl/shareCodec.js";
import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";
import type { MurmurProfile } from "../../protocol/MurmurProtocol.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createShareRuntime } from "../../sharing/createShareRuntime.js";
import { createSessionShareKind, type SessionShareKindOptions } from "../createSessionShareKind.js";
import type { SessionShareServiceContract } from "../SessionShareServiceContract.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

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
        const ownerRuntime = createSessionSharingRuntime({
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
        const friendRuntime = createSessionSharingRuntime({
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

/** A router failure must never escape into the Murmur synchronization loop. */
describe("the session-sharing event router", () => {
    it("absorbs a handler failure instead of stalling every Murmur topic", async () => {
        const relay = new InMemoryMurmurRelay();
        const peer = await createPeer(relay);
        const murmur = new FakeMurmurService(peer, { firstName: "Dana", lastName: "Owner" }, () => [
            /* friendships are never returned: the stub below fails first */
        ]);
        // Friendship lookup is the directory's first step for any inbox envelope, and it is
        // the sort of failure that must not escape: Murmur absorbs a thrown non-database
        // error and simply re-reads the same event, stalling every topic behind it forever.
        murmur.getFriends = () => Promise.reject(new Error("Friendship lookup exploded."));

        const store = new PersistentSessionStore({ databasePath: ":memory:" });
        cleanups.push(() => store.close());
        const reported: unknown[] = [];
        const runtime = createSessionSharingRuntime({
            daemonStore: store.sessionShareDaemonStore,
            deliverFriendMessage: () => {},
            murmur,
            reportFailure: (error) => reported.push(error),
            shareStore: store.sessionShares,
        });
        cleanups.push(() => void runtime.close());

        const envelope = encodeSharePrivateEnvelope(
            encryptPrivateMessageForContact(
                peer.identity,
                peer.identity,
                createPrivateMessage("{}"),
            ),
        );
        await peer.client.publishUnlinkable(identityInboxTopic(peer.identity), envelope);
        await expect(murmur.pump()).resolves.toBeUndefined();

        expect(reported).toHaveLength(1);
        expect((reported[0] as Error).message).toBe("Friendship lookup exploded.");
    }, 30_000);
});

/**
 * Session sharing over the one shared runtime, which is what the daemon builds.
 *
 * Every kind of share rides a single transport, directory, and event router, so a
 * test that wants only the session kind still goes through the same assembly.
 */
function createSessionSharingRuntime(options: {
    daemonStore: PersistentSessionStore["sessionShareDaemonStore"];
    deliverFriendMessage: SessionShareKindOptions["deliverFriendMessage"];
    murmur: FakeMurmurService;
    reportFailure?: (error: unknown) => void;
    shareStore: PersistentSessionStore["sessionShares"];
}): { close: () => Promise<void>; contract: SessionShareServiceContract } {
    const runtime = createShareRuntime({
        kinds: {
            session: createSessionShareKind({
                daemonStore: options.daemonStore,
                deliverFriendMessage: options.deliverFriendMessage,
                shareStore: options.shareStore,
            }),
        },
        murmur: options.murmur,
        ...(options.reportFailure === undefined ? {} : { reportFailure: options.reportFailure }),
    });
    return { close: runtime.close, contract: runtime.kinds.session.contract };
}

/** One Rig daemon's worth of session-sharing state for a peer. */
function createHost(murmur: FakeMurmurService): {
    runtime: ReturnType<typeof createSessionSharingRuntime>;
    store: PersistentSessionStore;
} {
    const store = new PersistentSessionStore({ databasePath: ":memory:" });
    const runtime = createSessionSharingRuntime({
        daemonStore: store.sessionShareDaemonStore,
        deliverFriendMessage: () => {},
        murmur,
        shareStore: store.sessionShares,
    });
    cleanups.push(() => store.close());
    cleanups.push(() => void runtime.close());
    return { runtime, store };
}
