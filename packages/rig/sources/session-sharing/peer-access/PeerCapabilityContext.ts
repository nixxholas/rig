import type { PermissionMode } from "../../permissions/PermissionMode.js";
import { resolvePeerCapabilityCeiling } from "./resolvePeerCapabilityCeiling.js";
import type {
    PeerAction,
    PeerActionOutcome,
    PeerCapability,
    PeerCapabilityDecision,
} from "./types.js";

/** Everything one peer action names about itself. */
export interface PeerCapabilityRequest {
    readonly action: PeerAction;
    readonly capability: PeerCapability;
    /** Epoch the friend's own frame claimed; a stale one is refused outright. */
    readonly grantEpoch: number;
    readonly shareId: string;
    readonly shareMemberId: string;
}

/** One live capability row, already checked against the member's current epoch. */
export interface ResolvedPeerGrant {
    readonly grantEpoch: number;
    /** Permission mode the owner's session is in right now. */
    readonly sessionMode: PermissionMode;
}

export interface PeerCapabilityContextOptions {
    /**
     * The one durable answer to gate one.
     *
     * Returning a grant means: this capability row exists, it is active, its
     * epoch is the member's current epoch, and the member itself is active.
     * Anything short of all four is `undefined`, because absence of a row is
     * denial and there is no third state to get wrong.
     */
    readonly resolveGrant: (request: PeerCapabilityRequest) => ResolvedPeerGrant | undefined;
    /** Records one decision durably. Runs after the decision, never before it. */
    readonly recordAction: (entry: {
        readonly action: PeerAction;
        readonly capability: PeerCapability;
        readonly grantEpoch: number;
        readonly outcome: PeerActionOutcome;
        readonly shareId: string;
        readonly shareMemberId: string;
    }) => void;
}

/**
 * One resource that exists only because a capability was granted.
 *
 * A peer channel, a terminal attachment, a request still waiting on an answer:
 * each registers here and is released synchronously when the grant behind it
 * ends, without waiting on the network.
 */
export interface PeerCapabilityHandle {
    readonly capability: PeerCapability;
    /** Released exactly once, synchronously, when the grant behind it ends. */
    close(): void;
    readonly grantEpoch: number;
    readonly shareId: string;
    readonly shareMemberId: string;
}

/**
 * Rig's authority over what a friend may do, held apart from the owner's own.
 *
 * `PermissionContext` says how far the owner has let their agent go. This says
 * how far the owner has let another person go, and the two never merge: a
 * friend is a different principal, not a quieter user, so nothing here can
 * raise the agent's authority and nothing there can grant a friend anything.
 *
 * Like `PermissionContext` it carries a revision. Every long-lived thing a
 * capability opened captures the revision it was authorized under and checks it
 * again before it acts, so a decision made a minute ago cannot outlive the
 * grant it rested on.
 */
export class PeerCapabilityContext {
    readonly #handles = new Set<PeerCapabilityHandle>();
    readonly #options: PeerCapabilityContextOptions;
    #revision = 0;

    constructor(options: PeerCapabilityContextOptions) {
        this.#options = options;
    }

    get revision(): number {
        return this.#revision;
    }

    /**
     * Decide one peer action against both gates, and record what was decided.
     *
     * Gate one is the durable grant. Gate two is the ceiling, resolved against
     * the session's live mode rather than the mode that was current when the
     * capability was granted — the capability is stored as intent, and what it
     * amounts to is worked out every single time it is used.
     */
    authorize(request: PeerCapabilityRequest): PeerCapabilityDecision {
        const grant = this.#options.resolveGrant(request);
        if (grant === undefined) {
            return this.#deny(
                request,
                request.grantEpoch,
                "You do not have permission to do this in this shared session. The person who shared it has not granted it, or has taken it back.",
            );
        }
        if (grant.grantEpoch !== request.grantEpoch) {
            return this.#deny(
                request,
                grant.grantEpoch,
                "Your access to this shared session was reissued, so this request used an out-of-date permission. Reconnect and try again.",
            );
        }
        const effectiveMode = resolvePeerCapabilityCeiling(grant.sessionMode, request.capability);
        this.#options.recordAction({
            action: request.action,
            capability: request.capability,
            grantEpoch: grant.grantEpoch,
            outcome: "allowed",
            shareId: request.shareId,
            shareMemberId: request.shareMemberId,
        });
        return {
            capability: request.capability,
            effectiveMode,
            grantEpoch: grant.grantEpoch,
            outcome: "allowed",
            revision: this.#revision,
            shareId: request.shareId,
            shareMemberId: request.shareMemberId,
        };
    }

    /** Refuse one action for a reason the caller already established. */
    deny(request: PeerCapabilityRequest, reason: string): PeerCapabilityDecision {
        return this.#deny(request, request.grantEpoch, reason);
    }

    /** Whether the decision this handle was opened under still holds. */
    isCurrent(revision: number): boolean {
        return this.#revision === revision;
    }

    /**
     * Attach one resource's lifetime to the grant that justified it.
     *
     * The returned function detaches without closing, for the ordinary case
     * where the resource ended on its own.
     */
    register(handle: PeerCapabilityHandle): () => void {
        this.#handles.add(handle);
        return () => this.#handles.delete(handle);
    }

    /**
     * End everything one member's grants opened, synchronously and locally.
     *
     * This is the step that actually secures a revocation. It runs immediately
     * after the persistence transaction commits and entirely inside the owner's
     * daemon, so nothing a friend holds survives the moment the owner decided
     * — the transport revoke and the capability broadcast that follow are only
     * how the friend's screen catches up with a channel that is already dead.
     */
    invalidate(scope: { readonly shareId: string; readonly shareMemberId?: string }): number {
        this.#revision += 1;
        let closed = 0;
        for (const handle of [...this.#handles]) {
            if (handle.shareId !== scope.shareId) continue;
            if (scope.shareMemberId !== undefined && handle.shareMemberId !== scope.shareMemberId) {
                continue;
            }
            this.#handles.delete(handle);
            closed += 1;
            try {
                handle.close();
            } catch {
                // A resource that fails to close is already unreachable from here; the
                // remaining handles still have to be released, so one failure never
                // leaves the rest of a revocation half-applied.
            }
        }
        return closed;
    }

    /** Release every handle, for daemon shutdown rather than for a revocation. */
    close(): void {
        for (const handle of [...this.#handles]) {
            this.#handles.delete(handle);
            try {
                handle.close();
            } catch {
                // Same reasoning as `invalidate`: shutdown must not stop halfway.
            }
        }
    }

    #deny(
        request: PeerCapabilityRequest,
        grantEpoch: number,
        reason: string,
    ): PeerCapabilityDecision {
        this.#options.recordAction({
            action: request.action,
            capability: request.capability,
            grantEpoch,
            outcome: "denied",
            shareId: request.shareId,
            shareMemberId: request.shareMemberId,
        });
        return { outcome: "denied", reason };
    }
}
