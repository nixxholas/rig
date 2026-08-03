import {
    decodeBase64Url,
    identityId,
    type IdentityPublicKeys,
    type ReceivedEvent,
} from "@slopus/murmur";
import type { MlsKeyPackage, MlsKeyPackageBundle } from "@slopus/murmur/mls";
import {
    SharedSessionMember,
    SharedSessionOwner,
    SharedSessionProtocolError,
    type SessionEntrySource,
    type SharedSessionCallbacks,
    type SharedSessionEntry,
    type SharedSessionInvitation,
    type SharedSessionPost,
    type SharedSessionState,
    type SharedSessionTermination,
} from "@slopus/murmur/sharedSession";

import type { MurmurRuntimeHandle } from "../murmur/types.js";
import { canonicalShareJson, shareContentHash } from "./canonicalShareJson.js";
import { ShareUnauthorizedPostError } from "./ShareUnauthorizedPostError.js";
import type {
    ShareOpaqueEntry,
    ShareTransport,
    ShareTransportGrant,
    ShareTransportMemberEvent,
    ShareTransportMemberPost,
    ShareTransportOwner,
    ShareTransportOwnerEvent,
} from "./ShareTransport.js";

/**
 * Everything the Murmur shared-session protocol needs about the people involved.
 *
 * Murmur deliberately ships no key-package directory and no invitation inbox:
 * an application transports both itself over a channel it already trusts. This
 * port is that channel, kept separate so the transport itself stays protocol
 * code.
 */
export interface ShareMurmurDirectory {
    /** Public identity of a friend Rig knows by Murmur peer ID. */
    identity(murmurPeerId: string): Promise<IdentityPublicKeys | undefined>;
    /** Human-readable name shown for a friend's messages. */
    displayName(murmurPeerId: string): Promise<string | undefined>;
    /** One fresh unused MLS key package authorizing this friend to be added. */
    keyPackage(murmurPeerId: string): Promise<MlsKeyPackage | undefined>;
    /** Ask a friend for a fresh key package after running out of the ones they offered. */
    requestKeyPackage(murmurPeerId: string): Promise<void>;
    /** Deliver one owner invitation to the friend it names. */
    deliver(invitation: SharedSessionInvitation): Promise<void>;
    /** The invitation and one-use bundle this daemon holds for a share it was invited to. */
    acceptedInvitation(shareId: string): Promise<
        | {
              readonly bundle: MlsKeyPackageBundle;
              readonly invitation: string;
              readonly owner: IdentityPublicKeys;
          }
        | undefined
    >;
}

export interface MurmurShareTransportOptions {
    readonly directory: ShareMurmurDirectory;
    /** Authoritative transcript history the owner offers to a newly invited member. */
    readonly entrySource: (shareId: string) => SessionEntrySource;
    readonly runtime: () => MurmurRuntimeHandle | undefined;
}

/** What happened to one received event, and therefore who owns its relay cursor. */
export type ShareEventOutcome = "applied" | "retained" | "unowned";

/** Bounded retry passes one catch-up will make before yielding to the next wake. */
const MAX_HISTORY_RETRY_PASSES = 512;

type OwnerHandler = (event: ShareTransportOwnerEvent) => void | Promise<void>;
type MemberHandler = (event: ShareTransportMemberEvent) => void | Promise<void>;

interface OwnerSession {
    /** Whether an append page has run yet, which bounds duplicate skipping to the first. */
    appendedThisSession: boolean;
    lastAppendedSequence: number;
    readonly session: SharedSessionOwner;
    state: SharedSessionState | undefined;
}

interface MemberSession {
    readonly grant: ShareTransportGrant;
    readonly session: SharedSessionMember;
    state: SharedSessionState | undefined;
    /** Murmur ended this replica and retired its cursors; it only absorbs events now. */
    terminated: boolean;
}

function grantKey(grant: ShareTransportGrant): string {
    return `${grant.shareId}\u0000${grant.shareMemberId}\u0000${String(grant.grantEpoch)}`;
}

function entryFromMurmur(shareId: string, entry: SharedSessionEntry): ShareOpaqueEntry {
    const canonicalJson = canonicalShareJson(entry.payload);
    return {
        canonicalJson,
        contentHash: shareContentHash(canonicalJson),
        createdAt: entry.timestamp,
        shareEventId: entry.shareEventId,
        shareId,
        shareSequence: entry.shareSequence,
    };
}

/**
 * Rig's session-share transport over the real Murmur shared-session protocol.
 *
 * The owner is the only accepted committer and the sole authority for state,
 * entries, history offers, revocation, and the terminal stop. Friend posts are
 * authenticated but carry no state authority, so they only ever become context
 * messages on the owner's side.
 *
 * Murmur mints its own member identifiers and grant epochs. Rig keeps its own,
 * so this adapter translates between the two by Murmur peer ID and never lets
 * Murmur's numbering leak into Rig's records.
 */
export class MurmurShareTransport implements ShareTransport {
    readonly #deferred = new Set<string>();
    readonly #directory: ShareMurmurDirectory;
    readonly #entrySource: MurmurShareTransportOptions["entrySource"];
    readonly #grants = new Map<string, Map<string, ShareTransportGrant>>();
    readonly #memberHandlers = new Map<string, Set<MemberHandler>>();
    readonly #members = new Map<string, MemberSession>();
    readonly #ownerHandlers = new Map<string, Set<OwnerHandler>>();
    readonly #owners = new Map<string, OwnerSession>();
    readonly #runtime: MurmurShareTransportOptions["runtime"];

    constructor(options: MurmurShareTransportOptions) {
        this.#directory = options.directory;
        this.#entrySource = options.entrySource;
        this.#runtime = options.runtime;
    }

    async createOwner(owner: ShareTransportOwner): Promise<void> {
        const runtime = this.#requireRuntime();
        const localPeerId = identityId(runtime.identity);
        if (owner.ownerPeerId !== localPeerId) {
            throw new Error("A session share can only be owned by this Murmur account.");
        }
        if (this.#owners.has(owner.shareId)) return;
        const loaded = await this.#loadOwnerSession(owner.shareId);
        if (loaded !== undefined) return;
        // Creating a share Rig already has a transcript for means Murmur lost the durable
        // owner state this share was built on. Starting a fresh group at sequence zero
        // would make every replayed entry look like a duplicate and silently publish
        // nothing, so the share degrades visibly instead.
        const existing = await this.#entrySource(owner.shareId).readPage({
            afterSequence: 0,
            maximumBytes: 1024,
            maximumEntries: 1,
        });
        if (existing.entries.length > 0) {
            throw new Error(
                "This shared session has a transcript but no Murmur state to resume it, so it cannot be republished.",
            );
        }
        const session = await SharedSessionOwner.create(owner.shareId, {
            callbacks: this.#ownerCallbacks(owner.shareId),
            client: runtime.client,
            entrySource: this.#entrySource(owner.shareId),
            identity: runtime.identity,
            invitationDelivery: { deliver: (invitation) => this.#directory.deliver(invitation) },
            store: runtime.store,
        });
        this.#owners.set(owner.shareId, {
            appendedThisSession: false,
            lastAppendedSequence: 0,
            session,
            state: session.state,
        });
    }

    async loadOwner(shareId: string): Promise<ShareTransportOwner | undefined> {
        const owner = this.#owners.get(shareId) ?? (await this.#loadOwnerSession(shareId));
        return owner === undefined
            ? undefined
            : { ownerPeerId: owner.session.state.ownerId, shareId };
    }

    async appendOwnerEntries(shareId: string, entries: readonly ShareOpaqueEntry[]): Promise<void> {
        const owner = await this.#requireOwner(shareId);
        for (const entry of entries) {
            if (entry.shareSequence <= owner.lastAppendedSequence) continue;
            try {
                await owner.session.append({
                    payload: JSON.parse(entry.canonicalJson) as never,
                    shareEventId: entry.shareEventId,
                    shareSequence: entry.shareSequence,
                    timestamp: entry.createdAt,
                });
                owner.appendedThisSession = true;
            } catch (error: unknown) {
                // Murmur raises one code whichever side is ahead, and it exposes no way to
                // read its committed maximum, so the two are told apart by how a duplicate
                // can arise at all. Rig acknowledges an outbox page only after Murmur has
                // durably committed it, so the only prefix Murmur can already hold is this
                // one unacknowledged page, resent by a restart before this session has
                // appended anything. Anywhere else Murmur is genuinely behind, and skipping
                // would drop an entry every member is then missing with no error at all.
                if (!isSequenceGap(error) || owner.appendedThisSession) throw error;
            }
            owner.lastAppendedSequence = entry.shareSequence;
        }
        // Only the first page of a resumed session can be a duplicate of what Murmur
        // already holds. Closing the window here keeps a later page from being skipped.
        owner.appendedThisSession = true;
    }

    async inviteMany(grants: readonly ShareTransportGrant[]): Promise<void> {
        if (grants.length === 0) throw new Error("An invite batch cannot be empty.");
        const shareIds = new Set(grants.map((grant) => grant.shareId));
        for (const shareId of shareIds) {
            const shareGrants = grants.filter((grant) => grant.shareId === shareId);
            const owner = await this.#requireOwner(shareId);
            const invitees = [];
            for (const grant of shareGrants) {
                this.#rememberGrant(grant);
                if (this.#isAlreadyActive(owner, grant)) continue;
                invitees.push(await this.#invitee(grant.murmurPeerId));
            }
            if (invitees.length === 0) continue;
            const result = await owner.session.inviteMany(invitees);
            owner.state = result.state;
        }
    }

    async invite(grant: ShareTransportGrant): Promise<void> {
        await this.inviteMany([grant]);
    }

    async revoke(grant: ShareTransportGrant): Promise<void> {
        const owner = await this.#requireOwner(grant.shareId);
        this.#forgetGrant(grant);
        // Murmur rejects revoking a grant it has already ended, and recovery has to be able
        // to replay a revocation that never reached it, so the two are told apart by asking
        // Murmur what it currently holds. A peer it no longer shows as active is done.
        if (!this.#isPeerActive(owner, grant.murmurPeerId)) return;
        // A Murmur peer ID is the base64url signing key, which is all a revocation
        // needs. Removal must never depend on the friendship still existing: an
        // unfriended member has to be removable, or they keep decrypting the share.
        owner.state = await owner.session.revoke({
            signingKey: decodeBase64Url(grant.murmurPeerId),
        });
    }

    async stop(shareId: string, _grants: readonly ShareTransportGrant[]): Promise<void> {
        const owner = this.#owners.get(shareId) ?? (await this.#loadOwnerSession(shareId));
        if (owner === undefined) return;
        owner.state = await owner.session.stop();
        this.#grants.delete(shareId);
        owner.session.destroy();
        this.#owners.delete(shareId);
    }

    handleOwnerEvents(shareId: string, callback: OwnerHandler): () => void {
        const handlers = this.#ownerHandlers.get(shareId) ?? new Set<OwnerHandler>();
        handlers.add(callback);
        this.#ownerHandlers.set(shareId, handlers);
        return () => {
            handlers.delete(callback);
            if (handlers.size === 0) this.#ownerHandlers.delete(shareId);
        };
    }

    async joinMember(grant: ShareTransportGrant): Promise<void> {
        const key = grantKey(grant);
        if (this.#members.get(key)?.terminated === false) return;
        const runtime = this.#requireRuntime();
        const accepted = await this.#directory.acceptedInvitation(grant.shareId);
        if (accepted === undefined) {
            throw new Error("No accepted invitation is held for this shared session.");
        }
        const session = await SharedSessionMember.join({
            callbacks: this.#memberCallbacks(grant),
            client: runtime.client,
            expectedOwner: accepted.owner,
            identity: runtime.identity,
            invitation: accepted.invitation,
            keyPackageBundle: accepted.bundle,
            store: runtime.store,
        });
        this.#evictTombstones(grant.shareId, key);
        this.#members.set(key, { grant, session, state: session.state, terminated: false });
    }

    async loadMember(grant: ShareTransportGrant): Promise<ShareTransportGrant | undefined> {
        const key = grantKey(grant);
        const existing = this.#members.get(key);
        if (existing !== undefined && !existing.terminated) return existing.grant;
        const runtime = this.#runtime();
        if (runtime === undefined) return undefined;
        let session: SharedSessionMember;
        try {
            session = await SharedSessionMember.load(grant.shareId, {
                callbacks: this.#memberCallbacks(grant),
                client: runtime.client,
                identity: runtime.identity,
                store: runtime.store,
            });
        } catch {
            return undefined;
        }
        this.#members.set(key, { grant, session, state: session.state, terminated: false });
        return grant;
    }

    async postMember(post: ShareTransportMemberPost): Promise<void> {
        const member = this.#members.get(grantKey(post.grant));
        if (member === undefined || member.terminated) {
            throw new Error("This shared session has no active membership to post into.");
        }
        await member.session.post(post.clientMessageId, post.text);
    }

    handleMemberEvents(grant: ShareTransportGrant, callback: MemberHandler): () => void {
        const key = grantKey(grant);
        const handlers = this.#memberHandlers.get(key) ?? new Set<MemberHandler>();
        handlers.add(callback);
        this.#memberHandlers.set(key, handlers);
        return () => {
            handlers.delete(callback);
            if (handlers.size === 0) this.#memberHandlers.delete(key);
        };
    }

    /** Retry a share's transport work, reporting whether it moved any history. */
    async retry(shareId: string): Promise<boolean> {
        const owner = this.#owners.get(shareId) ?? (await this.#loadOwnerSession(shareId));
        const sessions = [
            ...(owner === undefined ? [] : [owner.session]),
            // A terminated replica is kept only to absorb trailing events; Murmur has
            // deleted its protocol rows, so retrying it would fail on history it no
            // longer has.
            ...[...this.#members.values()]
                .filter((member) => member.grant.shareId === shareId && !member.terminated)
                .map((member) => member.session),
        ];
        const reports = [];
        for (const session of sessions) {
            // Murmur commits at most one history page per retry, and a pass that only
            // discovers the next offer reports zero pages while still having made
            // progress. So a single zero is not "done" — only two in a row are, and a
            // member catching up needs one pass per page until then.
            let idle = 0;
            for (let pass = 0; pass < MAX_HISTORY_RETRY_PASSES && idle < 2; pass += 1) {
                const report = await session.retry();
                reports.push(report);
                if (report.failures.length > 0) break;
                idle = report.historyPages === 0 && report.published === 0 ? idle + 1 : 0;
            }
        }
        const failures = reports.flatMap((report) => report.failures);
        if (failures.length > 0) {
            await this.#emitOwner(shareId, {
                error: failures[0]!.message,
                recoverable: true,
                shareId,
                type: "transport_failed",
            });
            return false;
        }
        await this.#emitOwner(shareId, { shareId, type: "transport_recovered" });
        // Only history counts. A member's own outgoing posts also land in `published`, so
        // counting them would let a replica that is stalled on a gap but still posting
        // reset its backoff on every pass and poll at the floor delay forever.
        return reports.some((report) => report.historyPages > 0);
    }

    /**
     * Apply one event the Murmur synchronization loop already read.
     *
     * `applied` means a live session owned the event and advanced its relay
     * cursor inside the same durable transaction as its effect. `retained`
     * means a session owns the event but is not ready for it yet, so the
     * cursor must stay where it is until a later pass replays it. Only
     * `unowned` leaves the caller responsible for advancing the cursor.
     */
    async handleReceivedEvent(received: ReceivedEvent): Promise<ShareEventOutcome> {
        for (const owner of this.#owners.values()) {
            const outcome = outcomeOf(await owner.session.handleEvent(received));
            if (outcome !== "unowned") return outcome;
        }
        for (const member of this.#members.values()) {
            const outcome = outcomeOf(await member.session.handleEvent(received));
            if (outcome === "unowned") continue;
            // A member defers because its history is incomplete, and only `retry` fetches
            // the missing pages. Without recording the share here, the live tail buffers to
            // Murmur's pending bound and every later event defers forever.
            if (outcome === "retained") this.#deferred.add(member.grant.shareId);
            return outcome;
        }
        return "unowned";
    }

    /** Shares whose replicas are waiting on history, cleared as the caller takes them. */
    takeDeferredShares(): readonly string[] {
        const shareIds = [...this.#deferred];
        this.#deferred.clear();
        return shareIds;
    }

    /**
     * Drop every cached session because the Murmur runtime behind them changed.
     *
     * The cached owner and member sessions hold the client and store they were built
     * on. After a stop, a restart, or an account deletion that replaces the store
     * outright, writing through them would write into a store that is gone.
     */
    resetRuntime(): void {
        // Handlers deliberately survive: they belong to the service's subscriptions, and a
        // runtime that comes back rebuilds the sessions behind the same subscribers.
        this.#destroySessions();
    }

    /** Release every in-memory epoch secret; durable state stays loadable. */
    close(): void {
        this.#destroySessions();
        this.#ownerHandlers.clear();
        this.#memberHandlers.clear();
    }

    #destroySessions(): void {
        for (const owner of this.#owners.values()) owner.session.destroy();
        for (const member of this.#members.values()) member.session.destroy();
        this.#owners.clear();
        this.#members.clear();
        this.#grants.clear();
        this.#deferred.clear();
    }

    #requireRuntime(): MurmurRuntimeHandle {
        const runtime = this.#runtime();
        if (runtime === undefined) {
            throw new Error("Session sharing needs the Murmur service to be running.");
        }
        return runtime;
    }

    async #requireOwner(shareId: string): Promise<OwnerSession> {
        const owner = this.#owners.get(shareId) ?? (await this.#loadOwnerSession(shareId));
        if (owner === undefined) throw new Error("This session share has no owner state.");
        return owner;
    }

    async #loadOwnerSession(shareId: string): Promise<OwnerSession | undefined> {
        const existing = this.#owners.get(shareId);
        if (existing !== undefined) return existing;
        const runtime = this.#runtime();
        if (runtime === undefined) return undefined;
        let session: SharedSessionOwner;
        try {
            session = await SharedSessionOwner.load(shareId, {
                callbacks: this.#ownerCallbacks(shareId),
                client: runtime.client,
                entrySource: this.#entrySource(shareId),
                identity: runtime.identity,
                invitationDelivery: {
                    deliver: (invitation) => this.#directory.deliver(invitation),
                },
                store: runtime.store,
            });
        } catch {
            return undefined;
        }
        const owner: OwnerSession = {
            appendedThisSession: false,
            lastAppendedSequence: 0,
            session,
            state: session.state,
        };
        this.#owners.set(shareId, owner);
        return owner;
    }

    async #invitee(
        murmurPeerId: string,
    ): Promise<{ identity: IdentityPublicKeys; keyPackage: MlsKeyPackage }> {
        const identity = await this.#directory.identity(murmurPeerId);
        if (identity === undefined) {
            throw new Error("This friend's Murmur identity is unknown.");
        }
        const keyPackage = await this.#directory.keyPackage(murmurPeerId);
        if (keyPackage === undefined) {
            // Every offer is one-use, so running out is ordinary. Asking now means the
            // friend's answer arrives on its own and the share completes on the retry.
            await this.#directory.requestKeyPackage(murmurPeerId);
            throw new Error(
                "This friend has no key package left, so Rig asked for a fresh one. The shared session finishes inviting them as soon as it arrives.",
            );
        }
        return { identity, keyPackage };
    }

    #isAlreadyActive(owner: OwnerSession, grant: ShareTransportGrant): boolean {
        return this.#isPeerActive(owner, grant.murmurPeerId);
    }

    /**
     * Whether Murmur still counts this peer as a member of the group.
     *
     * Murmur numbers its own grants, so a Rig epoch cannot be matched against one.
     * The peer is the whole identity a removal acts on, which makes this the only
     * question Murmur can answer and the only one either caller needs.
     */
    #isPeerActive(owner: OwnerSession, murmurPeerId: string): boolean {
        return (
            owner.state?.members.some(
                (member) => member.peerId === murmurPeerId && member.status === "active",
            ) === true
        );
    }

    #rememberGrant(grant: ShareTransportGrant): void {
        const shareGrants = this.#grants.get(grant.shareId) ?? new Map();
        shareGrants.set(grant.murmurPeerId, grant);
        this.#grants.set(grant.shareId, shareGrants);
    }

    #forgetGrant(grant: ShareTransportGrant): void {
        this.#grants.get(grant.shareId)?.delete(grant.murmurPeerId);
    }

    /**
     * Drop the tombstones a fresh membership makes obsolete.
     *
     * A tombstone exists only to absorb events still in flight for a replica Murmur
     * terminated. Once this peer holds a live membership in the same share again, the
     * new session owns that topic, so the old markers are dead weight rather than a
     * per-epoch leak for the life of the daemon.
     */
    #evictTombstones(shareId: string, keep: string): void {
        for (const [key, member] of this.#members) {
            if (key !== keep && member.grant.shareId === shareId && member.terminated) {
                this.#members.delete(key);
            }
        }
    }

    #ownerCallbacks(shareId: string): SharedSessionCallbacks {
        return {
            persistEntry: async () => {
                // The owner authored every entry; nothing is replicated back to it.
            },
            persistPost: async (_transaction, post) => {
                await this.#emitOwnerPost(shareId, post);
            },
            persistState: async (_transaction, state) => {
                const owner = this.#owners.get(shareId);
                if (owner !== undefined) owner.state = state;
            },
            terminate: async (_transaction, termination) => {
                this.#grants.delete(shareId);
                // Murmur has deleted this group's rows, so the cached owner session can no
                // longer append or retry. Dropping it makes the next attempt fail loudly
                // through `#requireOwner` instead of writing into a session that is gone.
                this.#owners.delete(shareId);
                await this.#emitOwner(shareId, {
                    error: terminationMessage(termination),
                    recoverable: false,
                    shareId,
                    type: "transport_failed",
                });
            },
        };
    }

    #memberCallbacks(grant: ShareTransportGrant): SharedSessionCallbacks {
        return {
            persistEntry: async (_transaction, entry) => {
                await this.#emitMember(grant, {
                    entries: [entryFromMurmur(grant.shareId, entry)],
                    grant,
                    type: "entries_appended",
                });
            },
            persistPost: async () => {
                // A member sees only its own posts echoed back; the owner owns them.
            },
            persistState: async (_transaction, state) => {
                const member = this.#members.get(grantKey(grant));
                if (member !== undefined) member.state = state;
            },
            terminate: async (_transaction, _termination) => {
                const member = this.#members.get(grantKey(grant));
                const stopped =
                    member?.state?.status === "stopped" || member?.state?.status === "terminated";
                // The destroyed session stays as a tombstone on purpose. Murmur retired
                // this topic's cursors when it terminated, so a trailing event from the
                // same batch must be absorbed here; letting it fall through to the
                // default path would try to advance a cursor that no longer exists.
                if (member !== undefined) member.terminated = true;
                await this.#emitMember(grant, {
                    grant,
                    reason: stopped ? "stopped" : "revoked",
                    type: "ended",
                });
            },
        };
    }

    async #emitOwnerPost(shareId: string, post: SharedSessionPost): Promise<void> {
        const grant = this.#grants.get(shareId)?.get(post.authenticatedPeerId);
        if (grant === undefined) {
            // A post from a peer Rig no longer grants access to carries no authority.
            return;
        }
        await this.#emitOwnerPostEvent(shareId, {
            post: {
                clientMessageId: post.postId,
                // Advisory only, and deliberately not a directory lookup: this runs inside
                // the Murmur store transaction, and the owner labels the message with the
                // name it registered for the member anyway.
                displayName: post.authenticatedPeerId,
                grant,
                text: post.text,
            },
            senderPeerId: post.authenticatedPeerId,
            type: "member_posted",
        });
    }

    /**
     * Deliver one owner event, dropping a post the current grant no longer accepts.
     *
     * This runs inside Murmur's store transaction, so an escaping rejection would
     * leave the relay cursor where it is and make the shared sync loop replay the
     * same event forever, stalling every other topic behind it. Losing an
     * unauthorized post is the correct outcome; losing the account's sync is not.
     */
    async #emitOwnerPostEvent(shareId: string, event: ShareTransportOwnerEvent): Promise<void> {
        try {
            await this.#emitOwner(shareId, event);
        } catch (error: unknown) {
            if (!(error instanceof ShareUnauthorizedPostError)) throw error;
        }
    }

    async #emitOwner(shareId: string, event: ShareTransportOwnerEvent): Promise<void> {
        for (const handler of this.#ownerHandlers.get(shareId) ?? []) await handler(event);
    }

    async #emitMember(grant: ShareTransportGrant, event: ShareTransportMemberEvent): Promise<void> {
        for (const handler of this.#memberHandlers.get(grantKey(grant)) ?? []) await handler(event);
    }
}

function isSequenceGap(error: unknown): boolean {
    return error instanceof SharedSessionProtocolError && error.code === "sequence-gap";
}

function outcomeOf(result: { readonly status: string }): ShareEventOutcome {
    if (result.status === "unhandled") return "unowned";
    // A deferred delivery is deliberately left on the relay cursor so a later pass replays
    // it in order; advancing here would create a gap the client rejects. Every other
    // handled status, termination included, already advanced the cursor transactionally.
    return result.status === "deferred" ? "retained" : "applied";
}

function terminationMessage(termination: SharedSessionTermination): string {
    if (termination.reason === "removed") return "This shared session removed the account.";
    if (termination.reason === "protocol-error") {
        return termination.error?.message ?? "The shared session failed its protocol checks.";
    }
    return "The shared session ended.";
}
