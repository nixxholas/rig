import { join } from "node:path";

import {
    DISCOVERY_INVITATION_TTL_MILLISECONDS,
    MurmurClient,
    isContactSessionDescriptor,
    type CreateMurmurSessionOptions,
    type MurmurContact,
    type MurmurContactProfile,
    type MurmurContactRequested,
    type MurmurSession,
    type MurmurSessionListOptions,
    type MurmurSessionPage,
    type MurmurSyncOptions,
} from "@slopus/murmur";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { TX } from "../persistence/Transaction.js";
import {
    querySharingProfileBinding,
    querySharingProfileId,
    sharingProfileBind,
    SqliteMurmurStore,
} from "../persistence/sharing/index.js";
import {
    createEventIdFactory,
    rigProfileSchema,
    type CreateSharingInvitationResponse,
    type FolderShareStatus,
    type RigProfile,
    type SharingChangedEvent,
    type SharingConnection,
    type SharingContact,
    type SharingContactRequest,
    type SharingOutgoingContactRequest,
    type SharingSnapshot,
} from "../protocol/index.js";
import type { RigProfileStore } from "../profiles/index.js";
import {
    FOLDER_SHARING_MURMUR_SERVICE_ID,
    FolderSharingService,
    type FolderSharingStore,
} from "./FolderSharingService.js";

export const DEFAULT_MURMUR_RELAY_URL = "https://murmur.cluster-fluster.com/";

const sharingMurmurProfileSchema = Type.Object(
    {
        profile: rigProfileSchema,
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);

interface SharingDatabase {
    query<Result>(operation: (tx: TX) => Result): Result;
    transaction<Result>(operation: (tx: TX) => Result): Result;
}

export interface SharingMurmurClient {
    readonly identity: Uint8Array;
    acceptContact(sessionId: Uint8Array, profile: MurmurContactProfile): Promise<void>;
    close(): void;
    contactRequests(): Promise<readonly MurmurContactRequested[]>;
    contacts(): Promise<readonly MurmurContact[]>;
    createSession(options: CreateMurmurSessionOptions): Promise<MurmurSession>;
    createInvitation(signal?: AbortSignal): Promise<Uint8Array>;
    rejectContact(sessionId: Uint8Array): Promise<void>;
    removeContact(identity: Uint8Array): Promise<void>;
    resolveInvitation(
        invitation: Uint8Array,
        signal?: AbortSignal,
    ): Promise<{ readonly identityKey: Uint8Array }>;
    requestContact(
        invitation: Uint8Array,
        profile: MurmurContactProfile,
        signal?: AbortSignal,
    ): Promise<MurmurSession>;
    sessions(options?: MurmurSessionListOptions): Promise<MurmurSessionPage>;
    send(id: Uint8Array, bytes: Uint8Array): Promise<string>;
    session(id: Uint8Array): Promise<MurmurSession | undefined>;
    sync(options?: MurmurSyncOptions): Promise<void>;
}

export interface SharingServiceOptions {
    client: SharingMurmurClient;
    database: SharingDatabase;
    folderSharing?: FolderSharingService;
    now?: () => number;
    onError?: (error: unknown) => void;
    profiles: RigProfileStore;
    publish: (event: SharingChangedEvent) => void;
    store?: SqliteMurmurStore;
}

export interface OpenSharingServiceOptions extends Omit<
    SharingServiceOptions,
    "client" | "folderSharing" | "store"
> {
    directory: string;
    folders?: FolderSharingStore;
    relay?: string | URL;
}

export interface SharingServiceContract {
    acceptContact(requestId: string): Promise<void>;
    createInvitation(signal?: AbortSignal): Promise<CreateSharingInvitationResponse>;
    createFolderShare(folderId: string, contacts: readonly string[]): Promise<FolderShareStatus>;
    foldersChanged(): void;
    rejectContact(requestId: string): Promise<void>;
    removeContact(identity: string): Promise<void>;
    requestContact(
        invitation: string,
        signal?: AbortSignal,
    ): Promise<SharingOutgoingContactRequest>;
    snapshot(): Promise<SharingSnapshot>;
}

export class SharingService implements SharingServiceContract {
    readonly #abort = new AbortController();
    readonly #activeOperations = new Set<Promise<unknown>>();
    readonly #client: SharingMurmurClient;
    readonly #database: SharingDatabase;
    readonly #identity: string;
    readonly #folderSharing: FolderSharingService | undefined;
    readonly #nextEventId: () => string;
    readonly #now: () => number;
    readonly #onError: (error: unknown) => void;
    readonly #profiles: RigProfileStore;
    readonly #publish: (event: SharingChangedEvent) => void;
    readonly #store: SqliteMurmurStore | undefined;
    #closePromise: Promise<void> | undefined;
    #closing = false;
    #connection: SharingConnection = "connecting";
    #publishTimer: ReturnType<typeof setTimeout> | undefined;
    #started = false;
    #sync: Promise<void> | undefined;
    #version: string;

    constructor(options: SharingServiceOptions) {
        this.#client = options.client;
        this.#database = options.database;
        this.#identity = encodeBytes(options.client.identity);
        this.#folderSharing = options.folderSharing;
        this.#now = options.now ?? Date.now;
        this.#nextEventId = createEventIdFactory({ now: this.#now });
        this.#onError = options.onError ?? (() => undefined);
        this.#profiles = options.profiles;
        this.#publish = options.publish;
        this.#store = options.store;
        this.#version = this.#nextEventId();
        const binding = this.#database.query(querySharingProfileBinding);
        if (binding !== undefined) {
            this.#database.transaction((tx) =>
                sharingProfileBind(tx, binding.profileId, this.#identity, this.#now()),
            );
        }
    }

    static async open(options: OpenSharingServiceOptions): Promise<SharingService> {
        const store = new SqliteMurmurStore(join(options.directory, "sharing-murmur.sqlite"));
        let client: MurmurClient | undefined;
        let service: SharingService | undefined;
        const folderSharing =
            options.folders === undefined
                ? undefined
                : new FolderSharingService({
                      database: options.database,
                      folders: options.folders,
                      ...(options.now === undefined ? {} : { now: options.now }),
                      onChanged: () => {
                          if (service !== undefined) service.#changed();
                      },
                      ...(options.onError === undefined ? {} : { onError: options.onError }),
                  });
        try {
            client = await MurmurClient.open({
                relay: options.relay ?? DEFAULT_MURMUR_RELAY_URL,
                ...(folderSharing === undefined
                    ? {}
                    : {
                          services: [
                              {
                                  id: FOLDER_SHARING_MURMUR_SERVICE_ID,
                                  service: folderSharing,
                              },
                          ],
                      }),
                store,
            });
            folderSharing?.attach(client);
            service = new SharingService({
                ...options,
                client,
                ...(folderSharing === undefined ? {} : { folderSharing }),
                store,
            });
            return service;
        } catch (error) {
            try {
                client?.close();
            } finally {
                await store.close();
            }
            throw error;
        }
    }

    start(): void {
        if (this.#closing) throw new Error("Sharing is closing.");
        if (this.#started) return;
        this.#started = true;
        this.#sync = (async () => {
            await this.#folderSharing?.recover();
            await this.#client.sync({
                abort: this.#abort.signal,
                onConnected: () => {
                    this.#connection = "connected";
                    this.#changed();
                    this.#folderSharing?.foldersChanged();
                },
                onContactAdded: () => this.#scheduleChanged(),
                onContactRemoved: () => this.#scheduleChanged(),
                onContactRequested: () => this.#scheduleChanged(),
                onDisconnected: () => {
                    this.#connection = "disconnected";
                    this.#changed();
                },
                onUpdates: () => undefined,
            });
        })().catch((error: unknown) => {
            if (this.#abort.signal.aborted) return;
            this.#connection = "disconnected";
            this.#changed();
            this.#onError(error);
        });
    }

    async snapshot(): Promise<SharingSnapshot> {
        return this.#run(async () => {
            const [contacts, folderShares, incomingRequests, sessions] = await Promise.all([
                this.#client.contacts(),
                this.#folderSharing?.statuses() ?? Promise.resolve([]),
                this.#client.contactRequests(),
                this.#listSessions(),
            ]);
            const knownSessionIds = new Set([
                ...contacts.map((contact) => encodeBytes(contact.sessionId)),
                ...incomingRequests.map((request) => encodeBytes(request.sessionId)),
            ]);
            const outgoingRequests: SharingOutgoingContactRequest[] = [];
            for (const session of sessions) {
                const sessionId = encodeBytes(session.id);
                if (
                    knownSessionIds.has(sessionId) ||
                    !isContactSessionDescriptor(session.descriptor) ||
                    session.status === "removed"
                ) {
                    continue;
                }
                const identity = session.members
                    .map(encodeBytes)
                    .find((candidate) => candidate !== this.#identity);
                if (identity === undefined) continue;
                outgoingRequests.push({ id: sessionId, identity, sessionId });
            }
            return {
                connection: this.#connection,
                contacts: contacts.map(toSharingContact),
                folderShares,
                identity: this.#identity,
                incomingRequests: incomingRequests.map(toSharingContactRequest),
                outgoingRequests,
                profileId: this.#database.query(querySharingProfileId) ?? null,
                version: this.#version,
            };
        });
    }

    bindProfile(profileId: string): void {
        if (this.#closing) throw new Error("Sharing is closing.");
        const profile = this.#profiles.get(profileId);
        if (profile === undefined || !this.#profiles.isLocal(profileId)) {
            throw new Error("Sharing requires a profile owned by this Rig.");
        }
        const result = this.#database.transaction((tx) =>
            sharingProfileBind(tx, profileId, this.#identity, this.#now()),
        );
        if (result === "created") this.#changed();
    }

    async createInvitation(signal?: AbortSignal): Promise<CreateSharingInvitationResponse> {
        this.#profile();
        const createdAt = this.#now();
        return this.#run(async () => {
            const invitation = await this.#client.createInvitation(this.#operationSignal(signal));
            return {
                expiresAt: createdAt + DISCOVERY_INVITATION_TTL_MILLISECONDS,
                invitation: encodeBytes(invitation),
            };
        });
    }

    createFolderShare(folderId: string, contacts: readonly string[]): Promise<FolderShareStatus> {
        const folderSharing = this.#folderSharing;
        if (folderSharing === undefined) {
            return Promise.reject(new Error("Folder Sharing is unavailable."));
        }
        return this.#run(() => folderSharing.create(folderId, contacts));
    }

    foldersChanged(): void {
        this.#folderSharing?.foldersChanged();
    }

    async requestContact(
        invitation: string,
        signal?: AbortSignal,
    ): Promise<SharingOutgoingContactRequest> {
        const profile = encodeProfile(this.#profile());
        return this.#run(async () => {
            const decodedInvitation = decodeBytes(invitation);
            const operationSignal = this.#operationSignal(signal);
            const bundle = await this.#client.resolveInvitation(decodedInvitation, operationSignal);
            const identity = encodeBytes(bundle.identityKey);
            const session = await this.#client.requestContact(
                decodedInvitation,
                profile,
                operationSignal,
            );
            this.#changed();
            const sessionId = encodeBytes(session.id);
            return { id: sessionId, identity, sessionId };
        });
    }

    async acceptContact(requestId: string): Promise<void> {
        const profile = encodeProfile(this.#profile());
        await this.#run(async () => {
            const request = await this.#request(requestId);
            if (decodeProfile(request.profile) === null) {
                throw new Error("The contact request does not contain a valid Rig profile.");
            }
            await this.#client.acceptContact(request.sessionId, profile);
            this.#changed();
        });
    }

    async rejectContact(requestId: string): Promise<void> {
        await this.#run(async () => {
            const request = await this.#request(requestId);
            await this.#client.rejectContact(request.sessionId);
            this.#changed();
        });
    }

    async removeContact(identity: string): Promise<void> {
        await this.#run(async () => {
            await this.#client.removeContact(decodeBytes(identity));
            this.#changed();
        });
    }

    close(): Promise<void> {
        this.#closePromise ??= this.#finishClose();
        return this.#closePromise;
    }

    async #finishClose(): Promise<void> {
        this.#closing = true;
        if (this.#publishTimer !== undefined) {
            clearTimeout(this.#publishTimer);
            this.#publishTimer = undefined;
        }
        this.#abort.abort();
        await this.#sync;
        while (this.#activeOperations.size > 0) {
            await Promise.allSettled(this.#activeOperations);
        }
        try {
            this.#client.close();
        } finally {
            await this.#store?.close();
        }
    }

    async #request(requestId: string): Promise<MurmurContactRequested> {
        const request = (await this.#client.contactRequests()).find(
            (candidate) => candidate.id === requestId,
        );
        if (request === undefined) throw new Error("Contact request not found.");
        return request;
    }

    #profile(): RigProfile {
        const profileId = this.#database.query(querySharingProfileId);
        const profile = profileId === undefined ? undefined : this.#profiles.get(profileId);
        if (profile === undefined || !this.#profiles.isLocal(profile.id)) {
            throw new Error("Choose a local Rig profile before using Sharing.");
        }
        return profile;
    }

    #run<Result>(operation: () => Promise<Result>): Promise<Result> {
        if (this.#closing) return Promise.reject(new Error("Sharing is closing."));
        const result = Promise.resolve().then(operation);
        this.#activeOperations.add(result);
        void result.then(
            () => this.#activeOperations.delete(result),
            () => this.#activeOperations.delete(result),
        );
        return result;
    }

    #operationSignal(signal: AbortSignal | undefined): AbortSignal {
        return signal === undefined
            ? this.#abort.signal
            : AbortSignal.any([signal, this.#abort.signal]);
    }

    async #listSessions(): Promise<readonly MurmurSession[]> {
        const sessions: MurmurSession[] = [];
        let after: string | undefined;
        do {
            const page = await this.#client.sessions({
                ...(after === undefined ? {} : { after }),
                limit: 256,
            });
            sessions.push(...page.sessions);
            after = page.cursor ?? undefined;
        } while (after !== undefined && sessions.length < 10_000);
        return sessions;
    }

    #scheduleChanged(): void {
        if (this.#publishTimer !== undefined) return;
        this.#publishTimer = setTimeout(() => {
            this.#publishTimer = undefined;
            this.#changed();
        }, 0);
        this.#publishTimer.unref?.();
    }

    #changed(): void {
        const id = this.#nextEventId();
        this.#version = id;
        this.#publish({
            createdAt: this.#now(),
            data: { version: id },
            id,
            type: "sharing_changed",
        });
    }
}

function encodeProfile(profile: RigProfile): MurmurContactProfile {
    const publicProfile: RigProfile = {
        createdAt: profile.createdAt,
        email: profile.email,
        id: profile.id,
        name: profile.name,
        parentInstanceId: profile.parentInstanceId,
        updatedAt: profile.updatedAt,
        version: profile.version,
    };
    return { profile: publicProfile, version: 1 } as unknown as MurmurContactProfile;
}

function decodeProfile(profile: MurmurContactProfile): RigProfile | null {
    if (!Value.Check(sharingMurmurProfileSchema, profile)) return null;
    return (profile as unknown as { profile: RigProfile }).profile;
}

function toSharingContact(contact: MurmurContact): SharingContact {
    return {
        identity: encodeBytes(contact.identity),
        profile: decodeProfile(contact.profile),
        status: contact.status,
    };
}

function toSharingContactRequest(request: MurmurContactRequested): SharingContactRequest {
    return {
        id: request.id,
        identity: encodeBytes(request.identity),
        profile: decodeProfile(request.profile),
        sessionId: encodeBytes(request.sessionId),
    };
}

function encodeBytes(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

function decodeBytes(value: string): Uint8Array {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== 32 || encodeBytes(decoded) !== value) {
        throw new Error("The Murmur identity or invitation is invalid.");
    }
    return decoded;
}
