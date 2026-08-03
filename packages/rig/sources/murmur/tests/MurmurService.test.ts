import {
    MemoryMurmurStore,
    createRelayEvent,
    decodeSignedRelayEventWire,
    destroyIdentity,
    encodeSignedRelayEventWire,
    encryptProfileForContact,
    generateIdentityKeyPair,
    identityId,
    identityInboxTopic,
    zeroBytes,
    type EventPage,
    type IdentityProfile,
    type ListPage,
    type PublishOutcome,
    type RelayBlob,
    type RelayTransport,
    type SignedRelayEvent,
    type StoreTransaction,
    type TopicState,
} from "@slopus/murmur";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MURMUR_RELAY_URLS, MurmurService } from "../index.js";
import { decodeMurmurIdentityToken } from "../impl/identityToken.js";
import {
    encodeFriendshipControl,
    encodeFriendshipProfileEnvelope,
} from "../impl/friendshipCodec.js";
import { MAX_MURMUR_PROFILE_PHOTO_BYTES } from "../impl/photoNormalize.js";
import type { MurmurLifecycleStore } from "../types.js";

class TestLifecycleStore implements MurmurLifecycleStore {
    readonly memory = new MemoryMurmurStore();
    closed = false;
    deleteFailuresRemaining: number;
    deleted = false;

    constructor(deleteFailuresRemaining = 0) {
        this.deleteFailuresRemaining = deleteFailuresRemaining;
    }

    get(key: string): Promise<Uint8Array | undefined> {
        return this.memory.get(key);
    }

    set(key: string, value: Uint8Array): Promise<void> {
        return this.memory.set(key, value);
    }

    delete(key: string): Promise<void> {
        return this.memory.delete(key);
    }

    list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return this.memory.list(prefix);
    }

    async listPage(
        prefix: string,
        after: string | undefined,
        limit: number,
    ): Promise<ReadonlyMap<string, Uint8Array>> {
        const values = await this.memory.list(prefix);
        const selected = [...values.entries()]
            .filter(([key]) => after === undefined || key > after)
            .sort(([left], [right]) => left.localeCompare(right))
            .slice(0, limit);
        const selectedKeys = new Set(selected.map(([key]) => key));
        for (const [key, bytes] of values) {
            if (!selectedKeys.has(key)) zeroBytes(bytes);
        }
        return new Map(selected);
    }

    transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        return this.memory.transaction(operation);
    }

    close(): void {
        this.closed = true;
    }

    deleteDatabaseFiles(): void {
        expect(this.closed).toBe(true);
        if (this.deleteFailuresRemaining > 0) {
            this.deleteFailuresRemaining -= 1;
            throw new Error("Simulated Murmur database deletion failure");
        }
        this.deleted = true;
    }
}

function cloneEvent(event: SignedRelayEvent): SignedRelayEvent {
    return decodeSignedRelayEventWire(encodeSignedRelayEventWire(event));
}

class TestRelay implements RelayTransport {
    readonly id: string;
    readonly events = new Map<string, SignedRelayEvent[]>();
    readonly blobs = new Map<string, RelayBlob>();
    publishCalls = 0;
    publishFailuresRemaining = 0;
    readStateCalls = 0;
    readStateFailuresRemaining = 0;
    resetNextRead = false;

    constructor(id = "test-relay") {
        this.id = id;
    }

    async publish(event: SignedRelayEvent): Promise<PublishOutcome> {
        this.publishCalls += 1;
        if (this.publishFailuresRemaining > 0) {
            this.publishFailuresRemaining -= 1;
            throw new Error("Simulated relay publish failure");
        }
        const events = this.events.get(event.topic) ?? [];
        const duplicate = events.findIndex((candidate) => candidate.id === event.id);
        if (duplicate >= 0) return { duplicate: true, seq: BigInt(duplicate + 1) };
        events.push(cloneEvent(event));
        this.events.set(event.topic, events);
        return { duplicate: false, seq: BigInt(events.length) };
    }

    async readState(topic: string): Promise<TopicState | undefined> {
        this.readStateCalls += 1;
        if (this.readStateFailuresRemaining > 0) {
            this.readStateFailuresRemaining -= 1;
            throw new Error("Simulated transient relay-state failure");
        }
        const events = this.events.get(topic);
        if (events === undefined) return undefined;
        const elements = new Map<string, { bytes: Uint8Array; id: string; version: bigint }>();
        for (const event of events) {
            for (const operation of event.list ?? []) {
                const current = elements.get(operation.id);
                if (operation.op === "append") {
                    if (current === undefined) {
                        elements.set(operation.id, {
                            bytes: operation.bytes.slice(),
                            id: operation.id,
                            version: 1n,
                        });
                    }
                } else if (operation.op === "replace") {
                    if (current !== undefined) {
                        elements.set(operation.id, {
                            bytes: operation.bytes.slice(),
                            id: operation.id,
                            version: current.version + 1n,
                        });
                    }
                } else {
                    elements.delete(operation.id);
                }
            }
        }
        return {
            list: {
                elements: [...elements.values()],
                nextCursor: null,
            },
            seq: BigInt(events.length),
            snapshot: null,
        };
    }

    async readList(): Promise<ListPage | undefined> {
        return { elements: [], nextCursor: null };
    }

    async readEvents(topic: string, since: bigint): Promise<EventPage | undefined> {
        const events = this.events.get(topic);
        if (events === undefined) return undefined;
        const reset = this.resetNextRead;
        this.resetNextRead = false;
        return {
            events: events
                .map((event, index) => ({ event: cloneEvent(event), seq: BigInt(index + 1) }))
                .filter((event) => event.seq > since),
            reset,
            seq: BigInt(events.length),
        };
    }

    async putBlob(blob: RelayBlob): Promise<void> {
        this.blobs.set(blob.id, { bytes: blob.bytes.slice(), id: blob.id });
    }

    async getBlob(id: string): Promise<RelayBlob | undefined> {
        const blob = this.blobs.get(id);
        return blob === undefined ? undefined : { bytes: blob.bytes.slice(), id: blob.id };
    }
}

async function publishForeignFriendRequest(
    relay: TestRelay,
    recipientToken: string,
    requestId: string,
    profile: IdentityProfile,
): Promise<string> {
    const sender = generateIdentityKeyPair();
    const recipient = decodeMurmurIdentityToken(recipientToken);
    const author = generateIdentityKeyPair();
    const sentAt = Date.now();
    const privateData = encodeFriendshipControl({
        action: "request",
        eventVersion: `event-${requestId}`,
        kind: "rig.murmur.friendship-control.v1",
        requestId,
        sentAt,
        version: 1,
    });
    const payload = encodeFriendshipProfileEnvelope(
        encryptProfileForContact(sender, recipient, profile, privateData),
    );
    const event = createRelayEvent(author, identityInboxTopic(recipient), payload, {
        list: [{ bytes: payload, id: `friend-request:${requestId}`, op: "append" }],
    });
    const senderId = identityId(sender);
    try {
        await relay.publish(event);
        return senderId;
    } finally {
        destroyIdentity(sender);
        destroyIdentity(author);
        zeroBytes(recipient.signingKey);
        zeroBytes(recipient.encryptionKey);
        zeroBytes(privateData);
        zeroBytes(payload);
        zeroBytes(event.author.signingKey);
        zeroBytes(event.payload);
        zeroBytes(event.signature);
        for (const operation of event.list ?? []) {
            if ("bytes" in operation) zeroBytes(operation.bytes);
        }
    }
}

function createService(
    relay: RelayTransport | readonly RelayTransport[] = new TestRelay(),
    publishGlobalEvent?: ConstructorParameters<typeof MurmurService>[0]["publishGlobalEvent"],
): {
    readonly service: MurmurService;
    readonly stores: TestLifecycleStore[];
} {
    const stores: TestLifecycleStore[] = [];
    const transports = Array.isArray(relay) ? relay : [relay];
    return {
        service: new MurmurService({
            storeFactory: () => {
                const store = new TestLifecycleStore();
                stores.push(store);
                return store;
            },
            syncRetryDelayMilliseconds: 0,
            syncWaitMilliseconds: 0,
            transportFactory: () => transports,
            ...(publishGlobalEvent === undefined ? {} : { publishGlobalEvent }),
        }),
        stores,
    };
}

describe("MurmurService", () => {
    it("signs up with a normalized WebP photo and never returns secret keys", async () => {
        const { service } = createService();
        const png = await sharp({
            create: {
                background: { alpha: 1, b: 80, g: 40, r: 220 },
                channels: 4,
                height: 900,
                width: 1_800,
            },
        })
            .png()
            .toBuffer();

        const signedUp = await service.signup({
            firstName: "Alice",
            lastName: "Example",
            photo: { data: png.toString("base64"), mediaType: "image/png" },
        });

        expect(signedUp.account.profile.photo).toMatchObject({
            height: 256,
            mediaType: "image/webp",
            width: 512,
        });
        expect(signedUp.account.profile.photo?.thumbhash).toBeTruthy();
        expect(
            await sharp(Buffer.from(signedUp.account.profile.photo!.data, "base64")).metadata(),
        ).toMatchObject({ format: "webp", height: 256, width: 512 });
        expect(JSON.stringify(signedUp)).not.toContain("SecretKey");
        expect(JSON.stringify(await service.getAccount())).not.toContain("SecretKey");
        expect((await service.start()).service).toEqual({
            relayUrls: [...DEFAULT_MURMUR_RELAY_URLS],
            status: "running",
        });
        await service.close();
    });

    it("keeps inbound profiles pending, then creates mutual contacts on accept", async () => {
        const relay = new TestRelay();
        const alice = createService(relay).service;
        const bob = createService(relay).service;
        const aliceAccount = (await alice.signup({ firstName: "Alice", lastName: "Example" }))
            .account;
        const bobAccount = (await bob.signup({ firstName: "Bob", lastName: "Example" })).account;
        await alice.start();

        await alice.sendFriendRequest({ token: bobAccount.token });
        relay.resetNextRead = true;
        relay.readStateFailuresRemaining = 1;
        await bob.start();
        await expect.poll(async () => (await bob.listFriendRequests()).requests.length).toBe(1);
        const first = (await bob.listFriendRequests()).requests[0]!;
        expect(first).toMatchObject({
            profile: { firstName: "Alice", lastName: "Example" },
            senderId: aliceAccount.id,
            senderToken: aliceAccount.token,
        });
        expect((await bob.listContacts()).contacts).toEqual([]);

        const accepted = await bob.answerFriendRequest(first.id, { answer: "accept" });
        expect(accepted.contact).toMatchObject({
            id: aliceAccount.id,
            profile: { firstName: "Alice", lastName: "Example" },
        });
        expect((await bob.listFriendRequests()).requests).toEqual([]);
        expect((await bob.listContacts()).contacts).toHaveLength(1);
        await expect
            .poll(async () => (await alice.listContacts()).contacts.map((item) => item.id))
            .toEqual([bobAccount.id]);
        const inboxTopic = [...relay.events.keys()][0]!;
        expect((await relay.readState(inboxTopic))?.list.elements).toEqual([]);

        const readStateCalls = relay.readStateCalls;
        relay.resetNextRead = true;
        await expect.poll(() => relay.readStateCalls).toBeGreaterThan(readStateCalls);
        expect((await bob.listFriendRequests()).requests).toEqual([]);

        await expect(alice.sendFriendRequest({ token: bobAccount.token })).resolves.toMatchObject({
            friendship: { state: "friends" },
            queued: false,
        });
        expect((await bob.listFriendRequests()).requests).toEqual([]);
        expect((await bob.listContacts()).contacts).toHaveLength(1);

        await alice.close();
        await bob.close();
    });

    it("accepts foreign CLI profiles and cannot let oversized metadata stall the inbox", async () => {
        const relay = new TestRelay();
        const bob = createService(relay).service;
        const bobAccount = (await bob.signup({ firstName: "Bob", lastName: "Example" })).account;
        await bob.start();

        const plainPeerId = await publishForeignFriendRequest(
            relay,
            bobAccount.token,
            "foreign-plain",
            { name: "Foreign Peer" },
        );
        await expect
            .poll(
                async () =>
                    (await bob.listFriendRequests()).requests.find(
                        (request) => request.senderId === plainPeerId,
                    )?.profile,
            )
            .toEqual({ firstName: "Foreign", lastName: "Peer" });
        await bob.answerFriendRequest(plainPeerId, { answer: "accept" });
        await expect
            .poll(
                async () =>
                    (await bob.getFriends()).contacts.find((contact) => contact.id === plainPeerId)
                        ?.profile,
            )
            .toEqual({ firstName: "Foreign", lastName: "Peer" });

        const metadata = Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [`foreign-${String(index)}`, "value"]),
        );
        metadata.oversized = "x".repeat(2_049);
        const oversizedPeerId = await publishForeignFriendRequest(
            relay,
            bobAccount.token,
            "foreign-oversized",
            { metadata, name: "Oversized Metadata" },
        );
        const followingPeerId = await publishForeignFriendRequest(
            relay,
            bobAccount.token,
            "foreign-following",
            { name: "Following Event" },
        );
        await expect
            .poll(async () =>
                (await bob.listFriendRequests()).requests.map((request) => request.senderId).sort(),
            )
            .toEqual([followingPeerId, oversizedPeerId].sort());
        await bob.answerFriendRequest(oversizedPeerId, { answer: "accept" });
        await expect
            .poll(
                async () =>
                    (await bob.getFriends()).contacts.find(
                        (contact) => contact.id === oversizedPeerId,
                    )?.profile,
            )
            .toEqual({ firstName: "Oversized", lastName: "Metadata" });

        const oversizedAvatar = new Uint8Array(MAX_MURMUR_PROFILE_PHOTO_BYTES + 1).fill(7);
        let oversizedAvatarPeerId: string;
        try {
            oversizedAvatarPeerId = await publishForeignFriendRequest(
                relay,
                bobAccount.token,
                "foreign-large-avatar",
                {
                    avatar: oversizedAvatar,
                    metadata: {
                        firstName: "Large",
                        lastName: "Avatar",
                        photoHeight: "512",
                        photoMediaType: "image/webp",
                        photoThumbhash: "thumbhash",
                        photoWidth: "512",
                    },
                    name: "Large Avatar",
                },
            );
        } finally {
            zeroBytes(oversizedAvatar);
        }
        await expect
            .poll(
                async () =>
                    (await bob.listFriendRequests()).requests.find(
                        (request) => request.senderId === oversizedAvatarPeerId,
                    )?.profile,
            )
            .toEqual({ firstName: "Large", lastName: "Avatar" });
        await bob.answerFriendRequest(oversizedAvatarPeerId, { answer: "accept" });
        const largeAvatarSnapshot = await bob.getFriends();
        expect(
            largeAvatarSnapshot.contacts.find((contact) => contact.id === oversizedAvatarPeerId)
                ?.profile,
        ).toEqual({ firstName: "Large", lastName: "Avatar" });
        expect(
            largeAvatarSnapshot.friendships.find(
                (friendship) => friendship.peerId === oversizedAvatarPeerId,
            )?.profile,
        ).toEqual({ firstName: "Large", lastName: "Avatar" });

        await bob.close();
    });

    it("tracks rejection and auto-accepts when the rejecting peer later reciprocates", async () => {
        const relay = new TestRelay();
        const alice = createService(relay).service;
        const bob = createService(relay).service;
        const aliceAccount = (await alice.signup({ firstName: "Alice", lastName: "Example" }))
            .account;
        const bobAccount = (await bob.signup({ firstName: "Bob", lastName: "Example" })).account;
        await alice.start();
        await bob.start();

        await alice.sendFriendRequest({ token: bobAccount.token });
        await expect.poll(async () => (await bob.listFriendRequests()).requests.length).toBe(1);
        await expect(
            bob.answerFriendRequest(aliceAccount.id, { answer: "reject" }),
        ).resolves.toMatchObject({
            answer: "reject",
            friendship: { state: "rejected_incoming" },
            stats: { rejectedRequests: 1 },
        });
        await expect
            .poll(
                async () =>
                    (await alice.getFriends()).friendships.find(
                        (friendship) => friendship.peerId === bobAccount.id,
                    )?.state,
            )
            .toBe("rejected_outgoing");

        await expect(bob.sendFriendRequest({ token: aliceAccount.token })).resolves.toMatchObject({
            friendship: { state: "outgoing_pending" },
        });
        await expect
            .poll(async () => (await alice.listContacts()).contacts.map((item) => item.id))
            .toEqual([bobAccount.id]);
        await expect
            .poll(async () => (await bob.listContacts()).contacts.map((item) => item.id))
            .toEqual([aliceAccount.id]);
        expect(await alice.getFriends()).toMatchObject({
            friendships: [
                {
                    history: { autoAccepted: 1 },
                    peerId: bobAccount.id,
                    state: "friends",
                },
            ],
            stats: { autoAcceptedRequests: 1, contacts: 1, rejectedRequests: 1 },
        });

        await alice.close();
        await bob.close();
    });

    it("publishes durable request and answer events with stable retry identities", async () => {
        const relay = new TestRelay();
        const deliveries: string[] = [];
        let rejectPublication = true;
        const alice = createService(relay, (event) => {
            deliveries.push(`${event.id}:${event.data.reason}:${event.data.direction}`);
            if (rejectPublication) throw new Error("Simulated global event database failure");
        });
        const bob = createService(relay);
        const bobAccount = (await bob.service.signup({ firstName: "Bob", lastName: "Example" }))
            .account;
        await alice.service.signup({ firstName: "Alice", lastName: "Example" });

        await expect(alice.service.sendFriendRequest({ token: bobAccount.token })).rejects.toThrow(
            "Simulated global event database failure",
        );
        const firstDelivery = deliveries[0]!;
        rejectPublication = false;
        expect((await alice.service.getFriends()).friendships).toMatchObject([
            { peerId: bobAccount.id, state: "outgoing_pending" },
        ]);
        expect(deliveries[1]).toBe(firstDelivery);
        expect(
            (await alice.stores[0]!.memory.list("rig/murmur/friendship-global-outbox/v1/")).size,
        ).toBe(0);

        await alice.service.start();
        await bob.service.start();
        await expect
            .poll(async () => (await bob.service.listFriendRequests()).requests.length)
            .toBe(1);
        await bob.service.answerFriendRequest(
            (await bob.service.listFriendRequests()).requests[0]!.id,
            { answer: "accept" },
        );
        await expect
            .poll(() => deliveries.some((delivery) => delivery.endsWith(":accepted:outgoing")))
            .toBe(true);

        await alice.service.close();
        await bob.service.close();
    });

    it("stops idempotently and deletes keys before reopening an empty usable store", async () => {
        const relay = new TestRelay();
        const { service, stores } = createService(relay);
        await service.signup({ firstName: "Alice", lastName: "Example" });
        await service.start();

        expect((await service.stop()).service.status).toBe("stopped");
        expect((await service.stop()).service.status).toBe("stopped");
        expect(await service.deleteAccount()).toEqual({ deleted: true });
        expect(stores[0]).toMatchObject({ closed: true, deleted: true });
        expect(await service.getAccount()).toEqual({
            service: { relayUrls: [], status: "stopped" },
        });
        await expect(service.start()).rejects.toMatchObject({ code: "account_missing" });
        await expect(
            service.signup({ firstName: "Fresh", lastName: "Identity" }),
        ).resolves.toMatchObject({ account: { profile: { firstName: "Fresh" } } });
        await service.close();
        await service.close();
    });

    it("caps pending requests before profile storage grows without bound", async () => {
        const relay = new TestRelay();
        const alice = createService(relay).service;
        const carol = createService(relay).service;
        const bobStore = new TestLifecycleStore();
        const bob = new MurmurService({
            maxRelationships: 1,
            storeFactory: () => bobStore,
            syncWaitMilliseconds: 0,
            transportFactory: () => [relay],
        });
        const bobAccount = (await bob.signup({ firstName: "Bob", lastName: "Example" })).account;
        await alice.signup({ firstName: "Alice", lastName: "Example" });
        await carol.signup({ firstName: "Carol", lastName: "Example" });
        await alice.start();
        await carol.start();
        await alice.sendFriendRequest({ token: bobAccount.token });
        await carol.sendFriendRequest({ token: bobAccount.token });

        await bob.start();
        await expect.poll(async () => (await bob.listFriendRequests()).requests.length).toBe(1);
        await expect
            .poll(
                async () =>
                    (await bobStore.memory.list("rig/murmur/friendship-quarantine/v1/")).size,
            )
            .toBe(1);
        expect((await bob.listFriendRequests()).requests).toHaveLength(1);

        await alice.close();
        await carol.close();
        await bob.close();
    });

    it("can retry account deletion after removing the database fails", async () => {
        const firstStore = new TestLifecycleStore(1);
        const stores = [firstStore];
        const service = new MurmurService({
            storeFactory: () => {
                const store =
                    stores.length === 1 && !firstStore.deleted
                        ? firstStore
                        : new TestLifecycleStore();
                if (store !== firstStore) stores.push(store);
                return store;
            },
        });
        await service.signup({ firstName: "Alice", lastName: "Example" });

        await expect(service.deleteAccount()).rejects.toThrow(
            "Simulated Murmur database deletion failure",
        );
        expect(firstStore).toMatchObject({ closed: true, deleted: false });
        await expect(service.deleteAccount()).resolves.toEqual({ deleted: true });
        await expect(service.getAccount()).resolves.toEqual({
            service: { relayUrls: [], status: "stopped" },
        });

        await service.close();
    });

    it("reuses one bounded prepared friend-request event across relay failures", async () => {
        const relay = new TestRelay();
        relay.publishFailuresRemaining = 1_000;
        const sender = createService(relay);
        const recipient = createService().service;
        const recipientToken = (await recipient.signup({ firstName: "Bob", lastName: "Example" }))
            .account.token;
        await sender.service.signup({ firstName: "Alice", lastName: "Example" });
        await sender.service.start();

        await expect(
            sender.service.sendFriendRequest({ token: recipientToken }),
        ).resolves.toMatchObject({ queued: true });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(
                sender.service.sendFriendRequest({ token: recipientToken }),
            ).resolves.toMatchObject({ queued: false });
        }
        expect(
            (await sender.stores[0]!.memory.list("rig/murmur/friendship-relay-outbox/v1/request/"))
                .size,
        ).toBe(1);
        expect((await sender.service.getFriends()).friendships[0]?.history.sent).toBe(1);

        relay.publishFailuresRemaining = 0;
        await expect
            .poll(
                async () =>
                    (
                        await sender.stores[0]!.memory.list(
                            "rig/murmur/friendship-relay-outbox/v1/request/",
                        )
                    ).size,
            )
            .toBe(0);
        expect([...relay.events.values()].flat()).toHaveLength(1);

        await sender.service.close();
        await recipient.close();
    });

    it("continues a partially published answer without deleting twice on one relay", async () => {
        const firstRelay = new TestRelay("first-relay");
        const secondRelay = new TestRelay("second-relay");
        const alice = createService([firstRelay, secondRelay]);
        const bob = createService([firstRelay, secondRelay]);
        const aliceAccount = (
            await alice.service.signup({ firstName: "Alice", lastName: "Example" })
        ).account;
        const bobAccount = (await bob.service.signup({ firstName: "Bob", lastName: "Example" }))
            .account;
        await alice.service.start();
        await bob.service.start();
        await alice.service.sendFriendRequest({ token: bobAccount.token });
        await expect
            .poll(async () => (await bob.service.listFriendRequests()).requests.length)
            .toBe(1);
        const request = (await bob.service.listFriendRequests()).requests[0]!;

        secondRelay.publishFailuresRemaining = 1_000;
        await expect(
            bob.service.answerFriendRequest(request.id, { answer: "accept" }),
        ).resolves.toMatchObject({
            answer: "accept",
            contact: { id: aliceAccount.id },
            friendship: { state: "friends" },
        });
        await expect
            .poll(
                async () =>
                    (await bob.stores[0]!.memory.list("rig/murmur/friendship-relay-outbox/v1/"))
                        .size,
            )
            .toBeGreaterThan(0);
        secondRelay.publishFailuresRemaining = 0;
        await expect
            .poll(
                async () =>
                    (await bob.stores[0]!.memory.list("rig/murmur/friendship-relay-outbox/v1/"))
                        .size,
            )
            .toBe(0);
        const firstRelayEventIds = [...firstRelay.events.values()].flat().map((event) => event.id);
        expect(new Set(firstRelayEventIds).size).toBe(firstRelayEventIds.length);
        await expect
            .poll(async () => (await alice.service.listContacts()).contacts.map((item) => item.id))
            .toEqual([bobAccount.id]);

        await alice.service.close();
        await bob.service.close();
    });

    it("bounds every hosted relay request", async () => {
        const recipient = createService().service;
        const recipientToken = (await recipient.signup({ firstName: "Bob", lastName: "Example" }))
            .account.token;
        const service = new MurmurService({
            relayRequestTimeoutMilliseconds: 10,
            storeFactory: () => new TestLifecycleStore(),
            syncWaitMilliseconds: 1_000,
        });
        const fetchMock = vi.fn(
            (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
                new Promise((_resolve, reject) => {
                    const signal = init?.signal;
                    if (signal == null) {
                        reject(new Error("Expected a bounded Murmur relay request"));
                        return;
                    }
                    const rejectAborted = () => reject(signal.reason);
                    if (signal.aborted) {
                        rejectAborted();
                    } else {
                        signal.addEventListener("abort", rejectAborted, { once: true });
                    }
                }),
        );
        vi.stubGlobal("fetch", fetchMock);

        try {
            await service.signup({ firstName: "Alice", lastName: "Example" });
            await service.start();
            await expect(
                service.sendFriendRequest({ token: recipientToken }),
            ).resolves.toMatchObject({ queued: true });
            await expect.poll(() => fetchMock.mock.calls.length).toBeGreaterThan(0);
            await expect
                .poll(async () => (await service.getFriends()).stats.outgoingPending)
                .toBe(1);
        } finally {
            await service.close();
            await recipient.close();
            vi.unstubAllGlobals();
        }
    });
});
