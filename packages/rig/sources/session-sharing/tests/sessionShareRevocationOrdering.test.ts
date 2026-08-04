import { describe, expect, it, vi } from "vitest";

import { FakeShareTransport } from "../../sharing/FakeShareTransport.js";
import { SessionShareService, type SessionSharePeerAccess } from "../SessionShareService.js";
import { MemorySessionShareStore, sequenceIds } from "./sessionShareTestFixtures.js";

/**
 * The one security property of a revocation: the in-memory channel has to be
 * dead before the transport is ever told, so a network failure can never leave
 * a friend's access alive. `store.revokeMember`/`store.stopShare` committing is
 * outside this test's view (it is a fake store), but the ordering between
 * `peerAccess.invalidate` and `transport.revoke`/`transport.stop` is exactly
 * what `SessionShareService` itself controls, and is what this test proves.
 */
function orderingPeerAccess(order: string[]): SessionSharePeerAccess {
    return {
        invalidate: (input) => {
            order.push(`invalidate:${input.shareMemberId ?? "*"}`);
            return 0;
        },
    };
}

describe("session-share revocation ordering", () => {
    it("closes the peer-access channel before revoke reaches the transport, and leaves no active capability row", async () => {
        const order: string[] = [];
        const transport = new FakeShareTransport();
        const originalRevoke = transport.revoke.bind(transport);
        vi.spyOn(transport, "revoke").mockImplementation(async (grant) => {
            order.push(`transport.revoke:${grant.shareMemberId}`);
            await originalRevoke(grant);
        });
        const store = new MemorySessionShareStore();
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1"),
            peerAccess: orderingPeerAccess(order),
            store,
            transport,
        });
        const share = await service.create({
            friends: [{ displayName: "Casey", murmurPeerId: "peer-casey" }],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        const member = share.members[0]!;
        await service.setMemberCapabilities({
            capabilities: ["terminal_view"],
            shareId: share.shareId,
            shareMemberId: member.shareMemberId,
        });
        expect(store.capabilitiesFor(share.shareId, member.shareMemberId)).toEqual([
            "terminal_view",
        ]);
        // Granting the capability invalidates too (a fresh grant closes any stale
        // channel under the old set); only the ordering around `revoke` itself matters here.
        order.length = 0;

        await service.revoke(share.shareId, member.shareMemberId);

        // The security property, proved by order rather than only by outcome: the
        // in-memory channel is already closed by the time the network is even asked.
        expect(order).toEqual([
            `invalidate:${member.shareMemberId}`,
            `transport.revoke:${member.shareMemberId}`,
        ]);
        expect(store.capabilitiesFor(share.shareId, member.shareMemberId)).toEqual([]);
        expect(store.queryShare(share.shareId)?.members).toEqual([
            expect.objectContaining({ shareMemberId: member.shareMemberId, state: "revoked" }),
        ]);
    });

    it("closes every peer-access channel before stop reaches the transport, and leaves no active capability row", async () => {
        const order: string[] = [];
        const transport = new FakeShareTransport();
        const originalStop = transport.stop.bind(transport);
        vi.spyOn(transport, "stop").mockImplementation(async (shareId, grants) => {
            order.push(`transport.stop:${shareId}`);
            await originalStop(shareId, grants);
        });
        const store = new MemorySessionShareStore();
        const service = new SessionShareService({
            deliverFriendMessage: () => undefined,
            idFactory: sequenceIds("share-1", "member-1", "member-2"),
            peerAccess: orderingPeerAccess(order),
            store,
            transport,
        });
        const share = await service.create({
            friends: [
                { displayName: "Casey", murmurPeerId: "peer-casey" },
                { displayName: "Riley", murmurPeerId: "peer-riley" },
            ],
            includeFriendMessagesInModel: true,
            ownerPeerId: "peer-owner",
            ownerSessionId: "session-1",
            toolOutput: "summaries",
        });
        for (const member of share.members) {
            await service.setMemberCapabilities({
                capabilities: ["terminal_view"],
                shareId: share.shareId,
                shareMemberId: member.shareMemberId,
            });
        }
        // Same reasoning as above: only the ordering around `stop` itself matters here.
        order.length = 0;

        await service.stop(share.shareId);

        // `stop` invalidates the whole share at once (no shareMemberId), and that has to
        // land before the one network call that ends every member's grant together.
        expect(order).toEqual([`invalidate:*`, `transport.stop:${share.shareId}`]);
        for (const member of share.members) {
            expect(store.capabilitiesFor(share.shareId, member.shareMemberId)).toEqual([]);
        }
        expect(
            store.queryShare(share.shareId)?.members.every((member) => member.state === "stopped"),
        ).toBe(true);
    });
});
