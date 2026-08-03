import { describe, expect, it, vi } from "vitest";

import { FakeSessionShareTransport } from "../FakeSessionShareTransport.js";
import type {
    SessionShareOpaqueEntry,
    SessionShareTransport,
    SessionShareTransportGrant,
} from "../SessionShareTransport.js";

type TransportFactory = () => SessionShareTransport;

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
