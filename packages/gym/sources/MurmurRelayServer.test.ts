import {
    HttpRelayTransport,
    MemoryMurmurStore,
    MurmurClient,
    generateIdentityKeyPair,
    type MurmurStore,
} from "@slopus/murmur";
import { afterEach, describe, expect, it } from "vitest";

import { MurmurRelayServer } from "./MurmurRelayServer.js";

interface Peer {
    readonly client: MurmurClient;
    readonly store: MurmurStore;
}

function createPeer(url: string): Peer {
    const store = new MemoryMurmurStore();
    return {
        client: new MurmurClient({
            identity: generateIdentityKeyPair(),
            store,
            transports: [new HttpRelayTransport("relay", url)],
        }),
        store,
    };
}

describe("MurmurRelayServer", () => {
    let server: MurmurRelayServer | undefined;

    afterEach(async () => {
        await server?.close();
        server = undefined;
    });

    it("round trips a published event and a blob over real HTTP", async () => {
        server = await MurmurRelayServer.start();
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

        const { client, store } = createPeer(server.url);
        const topic = "topic-round-trip";
        await client.subscribe(topic);

        await client.publish(topic, new TextEncoder().encode("hello relay"));

        const synced = await client.sync(0);
        if (synced.status !== "events") throw new Error(`Expected events, got ${synced.status}`);
        expect(synced.events).toHaveLength(1);
        const received = synced.events[0]!;
        expect(new TextDecoder().decode(received.event.payload)).toBe("hello relay");
        expect(received.seq).toBe(1n);

        await store.transaction(async (transaction) => {
            await received.advanceCursor(transaction);
        });

        const afterAdvance = await client.sync(0);
        if (afterAdvance.status !== "events") {
            throw new Error(`Expected events, got ${afterAdvance.status}`);
        }
        expect(afterAdvance.events).toHaveLength(0);

        const blobBytes = new TextEncoder().encode("blob content travels over real HTTP too");
        const putBlob = await client.putBlob(blobBytes);
        const fetchedBlob = await client.getBlob(putBlob.id);
        expect(fetchedBlob).toBeDefined();
        expect(Buffer.from(fetchedBlob!.bytes)).toEqual(Buffer.from(blobBytes));

        const missingBlob = await client.getBlob("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        expect(missingBlob).toBeUndefined();
    });

    it("delivers a published event from one real Murmur client to another through the relay", async () => {
        server = await MurmurRelayServer.start();
        const topic = "topic-peer-to-peer";

        const publisher = createPeer(server.url);
        const subscriber = createPeer(server.url);
        await subscriber.client.subscribe(topic);

        await publisher.client.publish(topic, new TextEncoder().encode("from publisher"));

        const synced = await subscriber.client.sync(0);
        if (synced.status !== "events") throw new Error(`Expected events, got ${synced.status}`);
        expect(synced.events).toHaveLength(1);
        expect(new TextDecoder().decode(synced.events[0]!.event.payload)).toBe("from publisher");

        await subscriber.store.transaction(async (transaction) => {
            await synced.events[0]!.advanceCursor(transaction);
        });

        // A second, independently identified peer publishing to the same topic must also arrive.
        const secondPublisher = createPeer(server.url);
        await secondPublisher.client.publish(
            topic,
            new TextEncoder().encode("from second publisher"),
        );

        const secondSync = await subscriber.client.sync(0);
        if (secondSync.status !== "events") {
            throw new Error(`Expected events, got ${secondSync.status}`);
        }
        expect(secondSync.events).toHaveLength(1);
        expect(new TextDecoder().decode(secondSync.events[0]!.event.payload)).toBe(
            "from second publisher",
        );
    });
});
