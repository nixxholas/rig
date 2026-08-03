import {
    MemoryMurmurStore,
    MurmurClient,
    generateIdentityKeyPair,
    identityId,
    type IdentityKeyPair,
    type MurmurStore,
} from "@slopus/murmur";
import type { SessionEntrySource } from "@slopus/murmur/sharedSession";
import { describe, expect, it, vi } from "vitest";

import { InMemoryMurmurRelay } from "../../murmur/InMemoryMurmurRelay.js";
import type { MurmurRuntimeHandle } from "../../murmur/types.js";
import { FakeSessionShareTransport } from "../FakeSessionShareTransport.js";
import {
    MurmurSessionShareTransport,
    type SessionShareMurmurDirectory,
} from "../MurmurSessionShareTransport.js";
import type {
    SessionShareOpaqueEntry,
    SessionShareTransport,
    SessionShareTransportGrant,
} from "../SessionShareTransport.js";

type TransportFactory = () => SessionShareTransport;

interface NeutralFixture {
    readonly ownerPeerId: string;
    readonly shareId: string;
    readonly transport: SessionShareTransport;
}

/**
 * Behaviours that hold for every `SessionShareTransport`, run against both the fake and
 * the real Murmur adapter.
 *
 * This set is deliberately small. The two transports are not behaviourally identical:
 * Murmur mints its own member identifiers and grant epochs and requires a real MLS key
 * package and invitation per invitee before a member can join, `loadMember` on the real
 * transport reflects durable per-member session state rather than an owner-side grant
 * registry, and real replication only reaches a member after `retry()` plus relay `sync()`
 * pumping (see MurmurSessionShareTransport.test.ts). Anything that depends on those
 * differences stays in the fake-only block below instead of being forced to match here.
 */
export function sessionShareTransportNeutralContract(
    name: string,
    createFixture: () => Promise<NeutralFixture> | NeutralFixture,
): void {
    describe(name, () => {
        it("creates an owner idempotently and loads it back", async () => {
            const { ownerPeerId, shareId, transport } = await createFixture();
            await transport.createOwner({ ownerPeerId, shareId });
            await transport.createOwner({ ownerPeerId, shareId });
            await expect(transport.loadOwner(shareId)).resolves.toEqual({ ownerPeerId, shareId });
        });

        it("returns undefined from loadOwner for an unknown share", async () => {
            const { shareId, transport } = await createFixture();
            await expect(transport.loadOwner(shareId)).resolves.toBeUndefined();
        });

        it("is idempotent when appending an already-published sequence", async () => {
            const { ownerPeerId, shareId, transport } = await createFixture();
            await transport.createOwner({ ownerPeerId, shareId });
            const entry = neutralEntry(shareId, 1);
            await transport.appendOwnerEntries(shareId, [entry]);
            await expect(transport.appendOwnerEntries(shareId, [entry])).resolves.toBeUndefined();
        });

        it("rejects an empty invite batch", async () => {
            const { transport } = await createFixture();
            await expect(transport.inviteMany([])).rejects.toThrow(
                "An invite batch cannot be empty.",
            );
        });

        it("is terminal after stop, so a later invite fails", async () => {
            const { ownerPeerId, shareId, transport } = await createFixture();
            await transport.createOwner({ ownerPeerId, shareId });
            await transport.stop(shareId, []);
            await expect(
                transport.invite({
                    grantEpoch: 1,
                    murmurPeerId: "peer-x",
                    shareId,
                    shareMemberId: "member-x",
                }),
            ).rejects.toThrow();
        });

        it("fails to post without an active membership", async () => {
            const { ownerPeerId, shareId, transport } = await createFixture();
            await transport.createOwner({ ownerPeerId, shareId });
            await expect(
                transport.postMember({
                    clientMessageId: "client-x",
                    displayName: "Nobody",
                    grant: {
                        grantEpoch: 1,
                        murmurPeerId: "peer-x",
                        shareId,
                        shareMemberId: "member-x",
                    },
                    text: "Hello",
                }),
            ).rejects.toThrow();
        });
    });
}

sessionShareTransportNeutralContract("FakeSessionShareTransport neutral contract", () => ({
    ownerPeerId: "owner",
    shareId: "share-neutral-1",
    transport: new FakeSessionShareTransport(),
}));

sessionShareTransportNeutralContract(
    "MurmurSessionShareTransport neutral contract",
    murmurNeutralFixture,
);

/**
 * Whole-lifecycle assertions kept fake-only.
 *
 * These exercise exact, synchronous behaviour the fake provides on purpose as a
 * deterministic double: immediate in-memory replay with no join step, an owner-side
 * grant registry that authorizes `loadMember`/`postMember` without a real member
 * session, and exact event-payload equality. The real transport cannot satisfy these
 * without a real MLS key package and invitation exchanged through
 * `SessionShareMurmurDirectory`, an explicit `joinMember`, and asynchronous
 * `retry()`/relay `sync()` pumping, all demonstrated end to end in
 * MurmurSessionShareTransport.test.ts. Bending these assertions to fit the real
 * transport would only weaken what they prove about the fake, so they stay here
 * unchanged.
 */
export function sessionShareTransportContract(name: string, factory: TransportFactory): void {
    describe(name, () => {
        it("creates, loads, invites as one batch, replays, posts, revokes, and stops", async () => {
            const transport = factory();
            const grant = fixtureGrant(1);
            const second = {
                ...fixtureGrant(1),
                murmurPeerId: "peer-2",
                shareMemberId: "member-2",
            };
            await transport.createOwner({ ownerPeerId: "owner", shareId: grant.shareId });
            await expect(transport.loadOwner(grant.shareId)).resolves.toEqual({
                ownerPeerId: "owner",
                shareId: grant.shareId,
            });
            await transport.appendOwnerEntries(grant.shareId, [fixtureEntry(1)]);

            const memberEvents = vi.fn();
            const ownerEvents = vi.fn();
            transport.handleMemberEvents(grant, memberEvents);
            transport.handleOwnerEvents(grant.shareId, ownerEvents);
            await transport.inviteMany([grant, second]);
            await expect(transport.loadMember(grant)).resolves.toEqual(grant);
            expect(memberEvents).toHaveBeenCalledWith(
                expect.objectContaining({ entries: [fixtureEntry(1)], type: "entries_appended" }),
            );

            await transport.postMember({
                clientMessageId: "client-1",
                displayName: "Friend",
                grant,
                text: "Hello",
            });
            expect(ownerEvents).toHaveBeenCalledWith(
                expect.objectContaining({
                    senderPeerId: grant.murmurPeerId,
                    type: "member_posted",
                }),
            );

            await transport.revoke(grant);
            expect(memberEvents).toHaveBeenCalledWith({
                grant,
                reason: "revoked",
                type: "ended",
            });
            await expect(transport.loadMember(grant)).resolves.toBeUndefined();
            await transport.stop(grant.shareId, [second]);
            await expect(transport.invite({ ...grant, grantEpoch: 2 })).rejects.toThrow("stopped");
        });

        it("deduplicates owner entries by stable event identity", async () => {
            const transport = factory();
            const grant = fixtureGrant(1);
            await transport.createOwner({ ownerPeerId: "owner", shareId: grant.shareId });
            await transport.appendOwnerEntries(grant.shareId, [fixtureEntry(1)]);
            await transport.appendOwnerEntries(grant.shareId, [fixtureEntry(1)]);
            const events = vi.fn();
            transport.handleMemberEvents(grant, events);
            await transport.invite(grant);
            expect(events).toHaveBeenCalledTimes(1);
            expect(events.mock.calls[0]?.[0].entries).toHaveLength(1);
        });
    });
}

sessionShareTransportContract(
    "FakeSessionShareTransport contract",
    () => new FakeSessionShareTransport(),
);

describe("FakeSessionShareTransport delivery controls", () => {
    it("fragments and reassembles a complete oversized opaque entry within wire bounds", async () => {
        const transport = new FakeSessionShareTransport();
        const grant = fixtureGrant(1);
        await transport.createOwner({ ownerPeerId: "owner", shareId: grant.shareId });
        const oversized = {
            ...fixtureEntry(1),
            canonicalJson: JSON.stringify({ output: "x".repeat(700_000) }),
        };
        await transport.appendOwnerEntries(grant.shareId, [oversized]);
        const events = vi.fn();
        transport.handleMemberEvents(grant, events);
        await transport.invite(grant);

        expect(transport.maximumPhysicalPageBytes()).toBeLessThanOrEqual(256 * 1024);
        expect(events).toHaveBeenCalledWith(
            expect.objectContaining({ entries: [oversized], type: "entries_appended" }),
        );
    });

    it("deterministically duplicates, reorders, drops, resets, delays ended, and fails", async () => {
        const transport = new FakeSessionShareTransport();
        const grant = fixtureGrant(1);
        await transport.createOwner({ ownerPeerId: "owner", shareId: grant.shareId });
        await transport.invite(grant);
        transport.setAutoDeliver(false);
        const events = vi.fn();
        transport.handleMemberEvents(grant, events);

        transport.duplicateNext();
        await transport.appendOwnerEntries(grant.shareId, [fixtureEntry(1)]);
        await transport.appendOwnerEntries(grant.shareId, [fixtureEntry(2)]);
        transport.dropNext();
        await transport.appendOwnerEntries(grant.shareId, [fixtureEntry(3)]);
        await transport.revoke(grant);
        expect(transport.queuedDeliveries()).toBe(4);

        await transport.flushNext(2);
        expect(events).toHaveBeenLastCalledWith(
            expect.objectContaining({ entries: [fixtureEntry(2)] }),
        );
        await transport.flushNext(2);
        expect(events).toHaveBeenLastCalledWith(
            expect.objectContaining({ reason: "revoked", type: "ended" }),
        );
        await transport.flushAll({ reverse: true });
        expect(events).toHaveBeenCalledTimes(4);

        transport.failNext("retry", new Error("relay offline"));
        await expect(transport.retry(grant.shareId)).rejects.toThrow("relay offline");
        transport.reset();
        expect(transport.queuedDeliveries()).toBe(0);
    });
});

function fixtureGrant(grantEpoch: number): SessionShareTransportGrant {
    return {
        grantEpoch,
        murmurPeerId: "peer-1",
        shareId: "share-1",
        shareMemberId: "member-1",
    };
}

function fixtureEntry(shareSequence: number): SessionShareOpaqueEntry {
    return {
        canonicalJson: JSON.stringify({ shareSequence }),
        contentHash: `hash-${String(shareSequence)}`,
        createdAt: shareSequence,
        shareEventId: `event-${String(shareSequence)}`,
        shareId: "share-1",
        shareSequence,
    };
}

function neutralEntry(shareId: string, shareSequence: number): SessionShareOpaqueEntry {
    return {
        canonicalJson: JSON.stringify({ note: `entry-${String(shareSequence)}` }),
        contentHash: `hash-${String(shareSequence)}`,
        createdAt: 1_700_000_000_000 + shareSequence,
        shareEventId: `0199f000-0000-7000-8000-00000000000${String(shareSequence)}`,
        shareId,
        shareSequence,
    };
}

interface MurmurPeer {
    readonly client: MurmurClient;
    readonly identity: IdentityKeyPair;
    readonly peerId: string;
    readonly store: MurmurStore;
}

function createMurmurPeer(relay: InMemoryMurmurRelay): MurmurPeer {
    const identity = generateIdentityKeyPair();
    const store = new MemoryMurmurStore();
    return {
        client: new MurmurClient({ identity, store, transports: [relay.transport("relay")] }),
        identity,
        peerId: identityId(identity),
        store,
    };
}

function emptyEntrySource(): SessionEntrySource {
    return { readPage: async () => ({ done: true, entries: [] }) };
}

/** A directory whose methods fail loudly if the neutral contract ever needs them. */
function unusedMurmurDirectory(): SessionShareMurmurDirectory {
    const fail = (): never => {
        throw new Error("The neutral contract must not need the Murmur directory.");
    };
    return {
        acceptedInvitation: async () => fail(),
        deliver: async () => fail(),
        displayName: async () => fail(),
        identity: async () => fail(),
        keyPackage: async () => fail(),
        requestKeyPackage: async () => fail(),
    };
}

function murmurNeutralFixture(): NeutralFixture {
    const relay = new InMemoryMurmurRelay();
    const owner = createMurmurPeer(relay);
    const runtime: MurmurRuntimeHandle = {
        client: owner.client,
        identity: owner.identity,
        store: owner.store,
    };
    const transport = new MurmurSessionShareTransport({
        directory: unusedMurmurDirectory(),
        entrySource: () => emptyEntrySource(),
        runtime: () => runtime,
    });
    return { ownerPeerId: owner.peerId, shareId: "share-neutral-1", transport };
}
