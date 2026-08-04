import { describe, expect, it, vi } from "vitest";

import type { PermissionMode } from "../../../permissions/PermissionMode.js";
import {
    PeerCapabilityContext,
    type PeerCapabilityRequest,
    type ResolvedPeerGrant,
} from "../PeerCapabilityContext.js";

function request(overrides: Partial<PeerCapabilityRequest> = {}): PeerCapabilityRequest {
    return {
        action: { detail: "term-1", name: "attach" },
        capability: "terminal_view",
        grantEpoch: 1,
        shareId: "share-1",
        shareMemberId: "member-1",
        ...overrides,
    };
}

describe("PeerCapabilityContext", () => {
    it("denies a member with no capability row, in one complete readable sentence naming no capability literal", () => {
        const recordAction = vi.fn();
        const context = new PeerCapabilityContext({ recordAction, resolveGrant: () => undefined });

        const decision = context.authorize(request());

        expect(decision.outcome).toBe("denied");
        if (decision.outcome !== "denied") throw new Error("unreachable");
        expect(decision.reason.endsWith(".")).toBe(true);
        expect(decision.reason).not.toMatch(/terminal_view/);
        expect(recordAction).toHaveBeenCalledWith(
            expect.objectContaining({ capability: "terminal_view", outcome: "denied" }),
        );
    });

    it("authorizes once a grant exists, then denies once the grant is revoked", () => {
        let grant: ResolvedPeerGrant | undefined = { grantEpoch: 1, sessionMode: "auto" };
        const context = new PeerCapabilityContext({
            recordAction: () => undefined,
            resolveGrant: () => grant,
        });

        const allowed = context.authorize(request());
        expect(allowed.outcome).toBe("allowed");

        // Revocation removes the row entirely; absence is denial, there is no third state.
        grant = undefined;
        const denied = context.authorize(request());
        expect(denied.outcome).toBe("denied");
    });

    it("refuses a stale grantEpoch even though a row exists for the member", () => {
        const context = new PeerCapabilityContext({
            recordAction: () => undefined,
            // The member's current epoch has moved to 2 (a revoke-and-reinvite), but the
            // request still carries the epoch it was issued under.
            resolveGrant: () => ({ grantEpoch: 2, sessionMode: "auto" }),
        });

        const decision = context.authorize(request({ grantEpoch: 1 }));

        expect(decision.outcome).toBe("denied");
    });

    it("caps gate two at read_only even when the owner's own session is in full_access", () => {
        const context = new PeerCapabilityContext({
            recordAction: () => undefined,
            resolveGrant: () => ({ grantEpoch: 1, sessionMode: "full_access" }),
        });

        const decision = context.authorize(request());

        expect(decision.outcome).toBe("allowed");
        if (decision.outcome !== "allowed") throw new Error("unreachable");
        expect(decision.effectiveMode).toBe("read_only");
        expect(decision.effectiveMode).not.toBe("full_access");
    });

    it("re-evaluates gate two against the session's live mode on every action, not a cached grant-time mode", () => {
        let sessionMode: PermissionMode = "full_access";
        const resolveGrant = vi.fn(
            (candidate: PeerCapabilityRequest): ResolvedPeerGrant => ({
                grantEpoch: candidate.grantEpoch,
                sessionMode,
            }),
        );
        const context = new PeerCapabilityContext({ recordAction: () => undefined, resolveGrant });

        const before = context.authorize(request());
        expect(before.outcome).toBe("allowed");
        if (before.outcome !== "allowed") throw new Error("unreachable");
        expect(before.effectiveMode).toBe("read_only");

        // The owner reduces their own session mode mid-session. The grant itself is
        // untouched: same shareId, same shareMemberId, same grantEpoch.
        sessionMode = "read_only";
        const after = context.authorize(request());
        expect(after.outcome).toBe("allowed");
        if (after.outcome !== "allowed") throw new Error("unreachable");
        expect(after.effectiveMode).toBe("read_only");

        // Both calls resolved the grant fresh; nothing about the session's mode was
        // remembered from the first authorization and reused for the second.
        expect(resolveGrant).toHaveBeenCalledTimes(2);
    });

    it("invalidate closes every registered handle synchronously, bumps the revision, and voids handles from the old revision", () => {
        const context = new PeerCapabilityContext({
            recordAction: () => undefined,
            resolveGrant: () => undefined,
        });
        const closed: string[] = [];
        const scope = { shareId: "share-1", shareMemberId: "member-1" };
        const revisionAtRegistration = context.revision(scope);
        context.register({
            capability: "terminal_view",
            close: () => closed.push("handle-1"),
            grantEpoch: 1,
            shareId: "share-1",
            shareMemberId: "member-1",
        });
        context.register({
            capability: "terminal_view",
            close: () => closed.push("handle-2"),
            grantEpoch: 1,
            shareId: "share-1",
            shareMemberId: "member-1",
        });

        const closedCount = context.invalidate({ shareId: "share-1", shareMemberId: "member-1" });

        // Both handles are already released by the time invalidate returns; nothing
        // asynchronous stands between the revocation and the resource actually closing.
        expect(closedCount).toBe(2);
        expect(closed.sort()).toEqual(["handle-1", "handle-2"]);
        expect(context.revision(scope)).toBe(revisionAtRegistration + 1);
        expect(context.isCurrent(scope, revisionAtRegistration)).toBe(false);
        expect(context.isCurrent(scope, context.revision(scope))).toBe(true);
    });

    it("invalidating one member never bumps another unrelated member's revision, so their live handle is not mistaken for stale", () => {
        const context = new PeerCapabilityContext({
            recordAction: () => undefined,
            resolveGrant: () => undefined,
        });
        const closed: string[] = [];
        const memberA = { shareId: "share-1", shareMemberId: "member-a" };
        const memberB = { shareId: "share-1", shareMemberId: "member-b" };
        context.register({
            capability: "terminal_view",
            close: () => closed.push("a"),
            grantEpoch: 1,
            shareId: memberA.shareId,
            shareMemberId: memberA.shareMemberId,
        });
        context.register({
            capability: "terminal_view",
            close: () => closed.push("b"),
            grantEpoch: 1,
            shareId: memberB.shareId,
            shareMemberId: memberB.shareMemberId,
        });
        const revisionBBeforeInvalidate = context.revision(memberB);

        const closedCount = context.invalidate(memberA);

        expect(closedCount).toBe(1);
        expect(closed).toEqual(["a"]);
        // Member B's handle was never closed, and its revision never moved either:
        // the revoked member and the unrelated member never share one counter.
        expect(context.revision(memberB)).toBe(revisionBBeforeInvalidate);
        expect(context.isCurrent(memberB, revisionBBeforeInvalidate)).toBe(true);
    });

    it("invalidating a whole share (no shareMemberId) bumps every member currently holding a handle on it", () => {
        const context = new PeerCapabilityContext({
            recordAction: () => undefined,
            resolveGrant: () => undefined,
        });
        const memberA = { shareId: "share-1", shareMemberId: "member-a" };
        const memberB = { shareId: "share-1", shareMemberId: "member-b" };
        context.register({
            capability: "terminal_view",
            close: () => undefined,
            grantEpoch: 1,
            shareId: memberA.shareId,
            shareMemberId: memberA.shareMemberId,
        });
        context.register({
            capability: "terminal_view",
            close: () => undefined,
            grantEpoch: 1,
            shareId: memberB.shareId,
            shareMemberId: memberB.shareMemberId,
        });
        const revisionA = context.revision(memberA);
        const revisionB = context.revision(memberB);

        const closedCount = context.invalidate({ shareId: "share-1" });

        expect(closedCount).toBe(2);
        expect(context.isCurrent(memberA, revisionA)).toBe(false);
        expect(context.isCurrent(memberB, revisionB)).toBe(false);
    });

    it("keeps closing the remaining handles when one handle's close() throws", () => {
        const context = new PeerCapabilityContext({
            recordAction: () => undefined,
            resolveGrant: () => undefined,
        });
        const closed: string[] = [];
        context.register({
            capability: "terminal_view",
            close: () => {
                throw new Error("this handle refuses to close cleanly");
            },
            grantEpoch: 1,
            shareId: "share-1",
            shareMemberId: "member-1",
        });
        context.register({
            capability: "terminal_view",
            close: () => closed.push("second"),
            grantEpoch: 1,
            shareId: "share-1",
            shareMemberId: "member-1",
        });

        const closedCount = context.invalidate({ shareId: "share-1", shareMemberId: "member-1" });

        // One failing close() must never leave the rest of a revocation half-applied.
        expect(closedCount).toBe(2);
        expect(closed).toEqual(["second"]);
    });
});
