import {
    contactSessionDescriptor,
    type CreateMurmurSessionOptions,
    type MurmurContact,
    type MurmurContactProfile,
    type MurmurContactRequested,
    type MurmurSession,
    type MurmurSessionListOptions,
    type MurmurSessionPage,
    type MurmurSyncOptions,
} from "@slopus/murmur";
import { describe, expect, it } from "vitest";

import { RigProfileStore } from "../profiles/index.js";
import { PersistentSessionStore } from "../session/PersistentSessionStore.js";
import { SharingService, type SharingMurmurClient } from "./SharingService.js";

const SELF = new Uint8Array(32).fill(1);
const REMOTE = new Uint8Array(32).fill(2);
const SESSION = new Uint8Array(32).fill(3);
const INVITATION = new Uint8Array(32).fill(4);

describe("SharingService", () => {
    it("binds the Murmur identity to the same local Rig profile and manages contacts", async () => {
        const database = new PersistentSessionStore({ databasePath: ":memory:" });
        const events: string[] = [];
        const profiles = new RigProfileStore({
            database,
            localInstanceId: "alocalinstance00000000001",
            publish: () => undefined,
        });
        const profile = profiles.create({
            email: "steve@example.test",
            name: "Steve",
            photo: {
                bytes: 90_000,
                data: "A".repeat(120_000),
                height: 1,
                mediaType: "image/webp",
                thumbhash: "dGh1bWI=",
                width: 1,
            },
        });
        const remoteProfile = {
            createdAt: 2,
            email: "remote@example.test",
            id: "aremoteprofile000000000001",
            name: "Remote",
            parentInstanceId: "aremoteinstance0000000001",
            updatedAt: 2,
            version: 1,
        };
        const client = new FakeMurmurClient({
            incoming: [
                {
                    id: "request-1",
                    identity: REMOTE,
                    profile: {
                        profile: remoteProfile,
                        version: 1,
                    } as unknown as MurmurContactProfile,
                    sessionId: SESSION,
                },
            ],
        });
        const sharing = new SharingService({
            client,
            database,
            now: () => 1_000,
            profiles,
            publish: (event) => events.push(event.type),
        });
        sharing.start();
        try {
            await expect(sharing.createInvitation()).rejects.toThrow("Choose a local Rig profile");
            sharing.bindProfile(profile.id);
            expect((await sharing.snapshot()).profileId).toBe(profile.id);
            expect(() =>
                sharing.bindProfile(
                    profiles.create({
                        email: "other@example.test",
                        name: "Other",
                    }).id,
                ),
            ).toThrow("already bound");

            await expect(sharing.createInvitation()).resolves.toEqual({
                expiresAt: 301_000,
                invitation: Buffer.from(INVITATION).toString("base64url"),
            });
            expect((await sharing.snapshot()).incomingRequests[0]).toMatchObject({
                id: "request-1",
                profile: remoteProfile,
            });

            await sharing.acceptContact("request-1");
            expect((await sharing.snapshot()).contacts).toEqual([
                {
                    identity: Buffer.from(REMOTE).toString("base64url"),
                    profile: remoteProfile,
                    status: "active",
                },
            ]);

            await sharing.removeContact(Buffer.from(REMOTE).toString("base64url"));
            expect((await sharing.snapshot()).contacts).toEqual([]);

            const outgoing = await sharing.requestContact(
                Buffer.from(INVITATION).toString("base64url"),
            );
            expect(client.localProfiles.at(-1)).toMatchObject({
                profile: { id: profile.id, name: "Steve" },
                version: 1,
            });
            expect(
                (client.localProfiles.at(-1) as { profile?: { photo?: unknown } } | undefined)
                    ?.profile?.photo,
            ).toBeUndefined();
            expect(outgoing.identity).toBe(Buffer.from(REMOTE).toString("base64url"));
            expect((await sharing.snapshot()).outgoingRequests).toContainEqual(outgoing);
            expect(events).toContain("sharing_changed");
        } finally {
            await sharing.close();
            database.close();
        }
    });

    it("refuses to attach a persisted profile binding to a different Murmur identity", async () => {
        const database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: "alocalinstance00000000001",
            publish: () => undefined,
        });
        const profile = profiles.create({ email: "steve@example.test", name: "Steve" });
        const sharing = new SharingService({
            client: new FakeMurmurClient(),
            database,
            profiles,
            publish: () => undefined,
        });
        sharing.bindProfile(profile.id);
        await sharing.close();
        try {
            expect(
                () =>
                    new SharingService({
                        client: new FakeMurmurClient({ identity: REMOTE }),
                        database,
                        profiles,
                        publish: () => undefined,
                    }),
            ).toThrow("stored Murmur identity does not match");
        } finally {
            database.close();
        }
    });

    it("drains an active snapshot before closing Murmur", async () => {
        let releaseContacts: (() => void) | undefined;
        const contactsGate = new Promise<void>((resolve) => {
            releaseContacts = resolve;
        });
        const database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: "alocalinstance00000000001",
            publish: () => undefined,
        });
        const client = new FakeMurmurClient({ contactsGate });
        const sharing = new SharingService({
            client,
            database,
            profiles,
            publish: () => undefined,
        });
        const snapshot = sharing.snapshot();
        const closing = sharing.close();
        expect(client.closed).toBe(false);
        releaseContacts?.();
        await snapshot;
        await closing;
        expect(client.closed).toBe(true);
        database.close();
    });

    it("aborts an active Murmur invitation upload while closing", async () => {
        const database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: "alocalinstance00000000001",
            publish: () => undefined,
        });
        const profile = profiles.create({ email: "steve@example.test", name: "Steve" });
        const client = new FakeMurmurClient({ invitationWaitsForAbort: true });
        const sharing = new SharingService({
            client,
            database,
            profiles,
            publish: () => undefined,
        });
        sharing.bindProfile(profile.id);
        const invitation = sharing.createInvitation();
        const aborted = expect(invitation).rejects.toThrow("invitation aborted");
        await Promise.resolve();
        await sharing.close();
        await aborted;
        expect(client.invitationSignal?.aborted).toBe(true);
        database.close();
    });

    it("does not accept a contact request whose Murmur profile is not a Rig profile", async () => {
        const database = new PersistentSessionStore({ databasePath: ":memory:" });
        const profiles = new RigProfileStore({
            database,
            localInstanceId: "alocalinstance00000000001",
            publish: () => undefined,
        });
        const profile = profiles.create({ email: "steve@example.test", name: "Steve" });
        const client = new FakeMurmurClient({
            incoming: [
                {
                    id: "invalid",
                    identity: REMOTE,
                    profile: { nickname: "not a Rig profile" },
                    sessionId: SESSION,
                },
            ],
        });
        const sharing = new SharingService({
            client,
            database,
            profiles,
            publish: () => undefined,
        });
        sharing.bindProfile(profile.id);
        try {
            expect((await sharing.snapshot()).incomingRequests[0]?.profile).toBeNull();
            await expect(sharing.acceptContact("invalid")).rejects.toThrow(
                "does not contain a valid Rig profile",
            );
        } finally {
            await sharing.close();
            database.close();
        }
    });
});

class FakeMurmurClient implements SharingMurmurClient {
    closed = false;
    readonly identity: Uint8Array;
    invitationSignal: AbortSignal | undefined;
    readonly localProfiles: MurmurContactProfile[] = [];
    readonly #contactsGate: Promise<void> | undefined;
    readonly #incoming: MurmurContactRequested[];
    readonly #invitationWaitsForAbort: boolean;
    readonly #contacts: MurmurContact[] = [];
    readonly #sessions: MurmurSession[] = [];

    constructor(
        options: {
            contactsGate?: Promise<void>;
            identity?: Uint8Array;
            incoming?: MurmurContactRequested[];
            invitationWaitsForAbort?: boolean;
        } = {},
    ) {
        this.#contactsGate = options.contactsGate;
        this.identity = options.identity ?? SELF;
        this.#incoming = [...(options.incoming ?? [])];
        this.#invitationWaitsForAbort = options.invitationWaitsForAbort ?? false;
    }

    async acceptContact(sessionId: Uint8Array, profile: MurmurContactProfile): Promise<void> {
        this.localProfiles.push(profile);
        const index = this.#incoming.findIndex((request) =>
            Buffer.from(request.sessionId).equals(Buffer.from(sessionId)),
        );
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
                    reject(new Error("invitation aborted"));
                    return;
                }
                signal?.addEventListener("abort", () => reject(new Error("invitation aborted")), {
                    once: true,
                });
            });
        }
        return INVITATION;
    }

    async createSession(options: CreateMurmurSessionOptions): Promise<MurmurSession> {
        const session: MurmurSession = {
            bufferedEvents: 0,
            committer: this.identity,
            descriptor: options.descriptor,
            id: SESSION,
            members: [this.identity, ...(options.contacts ?? []).map((member) => member)],
            status: "creating",
        };
        this.#sessions.push(session);
        return session;
    }

    async rejectContact(sessionId: Uint8Array): Promise<void> {
        const index = this.#incoming.findIndex((request) =>
            Buffer.from(request.sessionId).equals(Buffer.from(sessionId)),
        );
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
    ): Promise<MurmurSession> {
        this.localProfiles.push(profile);
        const session: MurmurSession = {
            bufferedEvents: 0,
            committer: SELF,
            descriptor: contactSessionDescriptor(),
            id: SESSION,
            members: [SELF],
            status: "creating",
        };
        this.#sessions.push({ ...session, members: [SELF, REMOTE] });
        return session;
    }

    async sessions(_options?: MurmurSessionListOptions): Promise<MurmurSessionPage> {
        return { cursor: null, sessions: this.#sessions };
    }

    async send(): Promise<string> {
        return "delivery-1";
    }

    async session(id: Uint8Array): Promise<MurmurSession | undefined> {
        return this.#sessions.find((session) => Buffer.from(session.id).equals(Buffer.from(id)));
    }

    async sync(options: MurmurSyncOptions = {}): Promise<void> {
        await options.onConnected?.();
        if (options.abort?.aborted === true) return;
        await new Promise<void>((resolve) => {
            options.abort?.addEventListener("abort", () => resolve(), { once: true });
        });
    }
}
