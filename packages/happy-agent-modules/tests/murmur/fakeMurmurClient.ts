import type {
    MurmurContact,
    MurmurContactProfile,
    MurmurContactRequested,
    MurmurOutgoingContactRequest,
    MurmurSynchronizeOptions,
    MurmurSynchronizeResult,
    MurmurSyncOptions,
} from "@slopus/murmur";

import type { MurmurClientFacade } from "../../sources/murmur/MurmurService.js";
import type { MurmurPeerProfile } from "../../sources/murmur/MurmurTypes.js";

/** Murmur values are always 32 raw bytes, which the service shows as 43 base64url characters. */
export function identityBytes(fill: number): Uint8Array {
    return new Uint8Array(32).fill(fill);
}

export function encodeIdentity(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

export const SELF = identityBytes(1);
export const REMOTE = identityBytes(2);
export const SESSION = identityBytes(3);
export const OTHER_SESSION = identityBytes(4);
export const INVITATION = identityBytes(5);

/** The envelope Murmur carries a profile in, built exactly as the service builds its own. */
export function carriedProfile(profile: MurmurPeerProfile): MurmurContactProfile {
    return { profile, version: 1 } as unknown as MurmurContactProfile;
}

export function peerProfile(overrides: Partial<MurmurPeerProfile> = {}): MurmurPeerProfile {
    return {
        createdAt: 2,
        email: "remote@example.test",
        id: "aremoteprofile0000000001",
        name: "Remote",
        parentInstanceId: "aremoteinstance000000001",
        updatedAt: 2,
        version: 1,
        ...overrides,
    };
}

export interface FakeMurmurClientOptions {
    readonly contacts?: readonly MurmurContact[];
    readonly identity?: Uint8Array;
    readonly incoming?: readonly MurmurContactRequested[];
    readonly invitationWaitsForAbort?: boolean;
    readonly syncErrors?: readonly unknown[];
}

/**
 * A Murmur client that never reaches a relay.
 *
 * The facade the service asks for is narrow on purpose, so every path through sharing can be
 * driven from here: contacts and requests are ordinary arrays, and the relay loop is a promise
 * that only ends when the service aborts it.
 */
export class FakeMurmurClient implements MurmurClientFacade {
    closed = false;
    readonly identity: Uint8Array;
    invitationSignal: AbortSignal | undefined;
    /** Every profile this installation put on the wire, newest last. */
    readonly sentProfiles: MurmurContactProfile[] = [];
    syncCalls = 0;
    readonly #contacts: MurmurContact[];
    readonly #incoming: MurmurContactRequested[];
    readonly #invitationWaitsForAbort: boolean;
    readonly #outgoing: MurmurOutgoingContactRequest[] = [];
    readonly #syncErrors: unknown[];
    #contactsGate: Promise<void> | undefined;

    constructor(options: FakeMurmurClientOptions = {}) {
        this.#contacts = [...(options.contacts ?? [])];
        this.identity = options.identity ?? SELF;
        this.#incoming = [...(options.incoming ?? [])];
        this.#invitationWaitsForAbort = options.invitationWaitsForAbort ?? false;
        this.#syncErrors = [...(options.syncErrors ?? [])];
    }

    /** Holds every later contact read until the returned function lets it through. */
    holdContacts(): () => void {
        let release!: () => void;
        this.#contactsGate = new Promise<void>((resolve) => {
            release = resolve;
        });
        return () => {
            this.#contactsGate = undefined;
            release();
        };
    }

    async acceptContact(sessionId: Uint8Array, profile: MurmurContactProfile): Promise<void> {
        this.sentProfiles.push(profile);
        const index = this.#requestIndex(sessionId);
        const request = this.#incoming[index];
        if (request === undefined) throw new Error("Unknown request");
        this.#incoming.splice(index, 1);
        this.#contacts.push({
            identity: request.identity,
            localProfile: profile,
            profile: request.profile,
            sessionId: request.sessionId,
            status: "active",
        });
    }

    close(): void {
        this.closed = true;
    }

    async contactRequests(): Promise<readonly MurmurContactRequested[]> {
        return this.#incoming;
    }

    async contacts(): Promise<readonly MurmurContact[]> {
        await this.#contactsGate;
        return this.#contacts;
    }

    async createInvitation(signal?: AbortSignal): Promise<Uint8Array> {
        this.invitationSignal = signal;
        if (this.#invitationWaitsForAbort) {
            await new Promise<void>((_resolve, reject) => {
                if (signal?.aborted === true) {
                    reject(new Error("The invitation was aborted."));
                    return;
                }
                signal?.addEventListener(
                    "abort",
                    () => reject(new Error("The invitation was aborted.")),
                    { once: true },
                );
            });
        }
        return INVITATION;
    }

    async outgoingContactRequests(): Promise<readonly MurmurOutgoingContactRequest[]> {
        return this.#outgoing;
    }

    async rejectContact(sessionId: Uint8Array): Promise<void> {
        const index = this.#requestIndex(sessionId);
        if (index < 0) throw new Error("Unknown request");
        this.#incoming.splice(index, 1);
    }

    async removeContact(identity: Uint8Array): Promise<void> {
        const index = this.#contacts.findIndex((contact) =>
            Buffer.from(contact.identity).equals(Buffer.from(identity)),
        );
        if (index < 0) throw new Error("Unknown contact");
        this.#contacts.splice(index, 1);
    }

    async resolveInvitation(): Promise<{ readonly identityKey: Uint8Array }> {
        return { identityKey: REMOTE };
    }

    async requestContact(
        _invitation: Uint8Array,
        profile: MurmurContactProfile,
    ): Promise<{ readonly id: Uint8Array }> {
        this.sentProfiles.push(profile);
        this.#outgoing.push({ createdAt: 1_000, identity: REMOTE, sessionId: SESSION });
        return { id: SESSION };
    }

    async synchronize(_options?: MurmurSynchronizeOptions): Promise<MurmurSynchronizeResult> {
        return {
            inbox: { cursor: null, exhausted: true, processed: 0, rejected: 0 },
            issues: [],
            pendingOutboxes: 0,
            published: 0,
            terminalPublicationFailures: 0,
            transientPublicationFailures: 0,
        };
    }

    async sync(options: MurmurSyncOptions = {}): Promise<void> {
        this.syncCalls += 1;
        const error = this.#syncErrors.shift();
        if (error !== undefined) throw error;
        await options.onConnected?.();
        if (options.abort?.aborted !== true) {
            await new Promise<void>((resolve) => {
                options.abort?.addEventListener("abort", () => resolve(), { once: true });
            });
        }
        await options.onDisconnected?.();
    }

    #requestIndex(sessionId: Uint8Array): number {
        return this.#incoming.findIndex((request) =>
            Buffer.from(request.sessionId).equals(Buffer.from(sessionId)),
        );
    }
}
