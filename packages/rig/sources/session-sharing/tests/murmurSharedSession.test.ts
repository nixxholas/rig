import {
    MemoryMurmurStore,
    MurmurClient,
    generateIdentityKeyPair,
    type IdentityKeyPair,
    type MurmurStore,
    type ReceivedEvent,
} from "@slopus/murmur";
import { createMlsKeyPackage } from "@slopus/murmur/mls";
import {
    SharedSessionMember,
    SharedSessionOwner,
    type SessionEntrySource,
    type SharedSessionCallbacks,
    type SharedSessionEntry,
    type SharedSessionInvitation,
    type SharedSessionInvitationDelivery,
    type SharedSessionPost,
    type SharedSessionState,
    type SharedSessionTermination,
} from "@slopus/murmur/sharedSession";
import { describe, expect, it } from "vitest";

import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";

interface Recorded {
    readonly entries: SharedSessionEntry[];
    readonly posts: SharedSessionPost[];
    readonly states: SharedSessionState[];
    readonly terminations: SharedSessionTermination[];
}

interface Peer {
    readonly client: MurmurClient;
    readonly identity: IdentityKeyPair;
    readonly recorded: Recorded;
    readonly store: MurmurStore;
}

function createPeer(relay: InMemoryMurmurRelay, relayId: string): Peer {
    const identity = generateIdentityKeyPair();
    const store = new MemoryMurmurStore();
    return {
        client: new MurmurClient({ identity, store, transports: [relay.transport(relayId)] }),
        identity,
        recorded: { entries: [], posts: [], states: [], terminations: [] },
        store,
    };
}

function recordingCallbacks(recorded: Recorded): SharedSessionCallbacks {
    return {
        persistEntry: async (_transaction, entry) => {
            recorded.entries.push(entry);
        },
        persistPost: async (_transaction, post) => {
            recorded.posts.push(post);
        },
        persistState: async (_transaction, state) => {
            recorded.states.push(state);
        },
        terminate: async (_transaction, termination) => {
            recorded.terminations.push(termination);
        },
    };
}

function capturingDelivery(captured: SharedSessionInvitation[]): SharedSessionInvitationDelivery {
    return {
        deliver: async (invitation) => {
            captured.push(invitation);
        },
    };
}

/** Serves owner history from the same authoritative list the owner appended. */
function entrySource(entries: readonly SharedSessionEntry[]): SessionEntrySource {
    return {
        readPage: async ({ afterSequence, maximumBytes, maximumEntries }) => {
            const remaining = entries.filter((entry) => entry.shareSequence > afterSequence);
            const page: SharedSessionEntry[] = [];
            let bytes = 0;
            for (const entry of remaining) {
                const size = JSON.stringify(entry.payload).length;
                if (
                    page.length > 0 &&
                    (page.length >= maximumEntries || bytes + size > maximumBytes)
                ) {
                    break;
                }
                page.push(entry);
                bytes += size;
            }
            return { done: page.length === remaining.length, entries: page };
        },
    };
}

/** Drains every subscribed topic once and dispatches each event to its session. */
async function pump(
    peer: Peer,
    sessions: readonly { handleEvent(received: ReceivedEvent): Promise<{ status: string }> }[],
): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
        const result = await peer.client.sync(0);
        if (result.status === "reset") continue;
        if (result.events.length === 0) return;
        for (const received of result.events) {
            let handled = false;
            for (const session of sessions) {
                const outcome = await session.handleEvent(received);
                if (outcome.status !== "unhandled") {
                    handled = true;
                    break;
                }
            }
            if (!handled) {
                await peer.store.transaction(async (transaction) => {
                    await received.advanceCursor(transaction);
                });
            }
        }
    }
}

describe("Murmur shared sessions over an in-process relay", () => {
    it("replicates owner entries, friend posts, and revocation to a real member", async () => {
        const relay = new InMemoryMurmurRelay();
        const owner = createPeer(relay, "relay");
        const friend = createPeer(relay, "relay");
        const invitations: SharedSessionInvitation[] = [];
        const appended: SharedSessionEntry[] = [];

        const ownerSession = await SharedSessionOwner.create("share-1", {
            callbacks: recordingCallbacks(owner.recorded),
            client: owner.client,
            entrySource: entrySource(appended),
            identity: owner.identity,
            invitationDelivery: capturingDelivery(invitations),
            store: owner.store,
        });

        for (let sequence = 1; sequence <= 3; sequence += 1) {
            appended.push(
                await ownerSession.append({
                    payload: { kind: "event", text: `entry ${String(sequence)}` },
                    shareSequence: sequence,
                    timestamp: 1_700_000_000_000 + sequence,
                }),
            );
        }

        const bundle = createMlsKeyPackage(friend.identity);
        const invited = await ownerSession.inviteMany([
            { identity: friend.identity, keyPackage: bundle.keyPackage },
        ]);

        expect(invited.state.members).toHaveLength(1);
        expect(invitations).toHaveLength(1);

        const friendSession = await SharedSessionMember.join({
            callbacks: recordingCallbacks(friend.recorded),
            client: friend.client,
            expectedOwner: owner.identity,
            identity: friend.identity,
            invitation: invitations[0]!.text,
            keyPackageBundle: bundle,
            store: friend.store,
        });

        for (let round = 0; round < 8; round += 1) {
            await ownerSession.retry();
            await pump(owner, [ownerSession]);
            await friendSession.retry();
            await pump(friend, [friendSession]);
            if (friend.recorded.entries.length >= 3) break;
        }

        expect(friend.recorded.entries.map((entry) => entry.shareSequence).sort()).toEqual([
            1, 2, 3,
        ]);

        await friendSession.post("post-1", "Please also check the tests.");
        await pump(owner, [ownerSession]);

        expect(owner.recorded.posts).toHaveLength(1);
        expect(owner.recorded.posts[0]).toMatchObject({
            postId: "post-1",
            text: "Please also check the tests.",
        });

        await ownerSession.revoke(friend.identity);
        await pump(friend, [friendSession]);

        // A revoked grant reaches the friend as an authenticated ended state, which is what
        // retires the replica; MLS removal only follows for a member the owner drops entirely.
        expect(friend.recorded.terminations.map((termination) => termination.reason)).toContain(
            "ended",
        );

        ownerSession.destroy();
        friendSession.destroy();
    }, 60_000);
});
