import {
    MAX_RELAY_BLOB_BYTES,
    MAX_RELAY_EVENT_PAYLOAD_BYTES,
    verifyRelayBlob,
    verifyRelayEvent,
    type EventPage,
    type ListPage,
    type PublishOutcome,
    type RelayBlob,
    type RelayTransport,
    type SignedRelayEvent,
    type TopicSnapshot,
    type TopicState,
} from "@slopus/murmur";

const DEFAULT_PAGE_LIMIT = 256;

interface StoredListElement {
    bytes: Uint8Array;
    order: number;
    version: bigint;
}

interface StoredTopic {
    readonly events: { readonly event: SignedRelayEvent; readonly seq: bigint }[];
    readonly eventSeqById: Map<string, bigint>;
    readonly list: Map<string, StoredListElement>;
    nextListOrder: number;
    seq: bigint;
    snapshot: TopicSnapshot | null;
}

function createTopic(): StoredTopic {
    return {
        events: [],
        eventSeqById: new Map(),
        list: new Map(),
        nextListOrder: 0,
        seq: 0n,
        snapshot: null,
    };
}

/**
 * Complete in-process implementation of the fixed Murmur relay contract.
 *
 * Several `RelayTransport` instances may share one relay, so two Murmur clients
 * in the same process exchange real signed events, snapshots, list state, and
 * ciphertext blobs without a network relay.
 */
export class InMemoryMurmurRelay {
    readonly #blobs = new Map<string, Uint8Array>();
    readonly #topics = new Map<string, StoredTopic>();
    readonly #waiters = new Set<() => void>();

    /** Create one transport view of this relay. */
    transport(id: string): RelayTransport {
        return {
            id,
            getBlob: async (blobId, expectedBytes) => this.getBlob(blobId, expectedBytes),
            publish: async (event) => this.publish(event),
            putBlob: async (blob) => {
                this.putBlob(blob);
            },
            readEvents: async (topic, since, limit, wait, signal) =>
                this.readEvents(topic, since, limit, wait, signal),
            readList: async (topic, cursor, limit) => this.readList(topic, cursor, limit),
            readState: async (topic, limit) => this.readState(topic, limit),
        };
    }

    publish(event: SignedRelayEvent): PublishOutcome {
        if (event.payload.length > MAX_RELAY_EVENT_PAYLOAD_BYTES) {
            throw new Error("Relay event payload is too large");
        }
        if (!verifyRelayEvent(event)) throw new Error("Relay event signature is invalid");
        const topic = this.#topics.get(event.topic) ?? createTopic();
        this.#topics.set(event.topic, topic);
        const existing = topic.eventSeqById.get(event.id);
        if (existing !== undefined) {
            return {
                duplicate: true,
                seq: existing,
                ...(topic.snapshot === null ? {} : { snapshotVersion: topic.snapshot.version }),
            };
        }
        const snapshotMutation = event.snapshot;
        if (snapshotMutation !== undefined) {
            const currentVersion = topic.snapshot === null ? 0n : topic.snapshot.version;
            if (BigInt(snapshotMutation.expectedVersion) !== currentVersion) {
                throw new Error("Relay snapshot version conflict");
            }
        }
        for (const operation of event.list ?? []) {
            const element = topic.list.get(operation.id);
            if (operation.op === "append") {
                if (element !== undefined) throw new Error("Relay list element already exists");
                continue;
            }
            if (element === undefined) throw new Error("Relay list element does not exist");
            if (
                operation.expectedVersion !== undefined &&
                BigInt(operation.expectedVersion) !== element.version
            ) {
                throw new Error("Relay list element version conflict");
            }
        }
        topic.seq += 1n;
        topic.events.push({ event, seq: topic.seq });
        topic.eventSeqById.set(event.id, topic.seq);
        if (snapshotMutation !== undefined) {
            const nextVersion = (topic.snapshot === null ? 0n : topic.snapshot.version) + 1n;
            topic.snapshot =
                snapshotMutation.bytes === undefined
                    ? null
                    : { bytes: snapshotMutation.bytes.slice(), version: nextVersion };
        }
        for (const operation of event.list ?? []) {
            if (operation.op === "delete") {
                topic.list.delete(operation.id);
                continue;
            }
            if (operation.op === "append") {
                topic.nextListOrder += 1;
                topic.list.set(operation.id, {
                    bytes: operation.bytes.slice(),
                    order: topic.nextListOrder,
                    version: 1n,
                });
                continue;
            }
            const element = topic.list.get(operation.id)!;
            element.bytes = operation.bytes.slice();
            element.version += 1n;
        }
        this.#wake();
        return {
            duplicate: false,
            seq: topic.seq,
            ...(topic.snapshot === null ? {} : { snapshotVersion: topic.snapshot.version }),
        };
    }

    readState(topic: string, limit?: number): TopicState | undefined {
        const stored = this.#topics.get(topic);
        if (stored === undefined) return undefined;
        return {
            list: this.#listPage(stored, undefined, limit),
            seq: stored.seq,
            snapshot:
                stored.snapshot === null
                    ? null
                    : { bytes: stored.snapshot.bytes.slice(), version: stored.snapshot.version },
        };
    }

    readList(topic: string, cursor?: string, limit?: number): ListPage | undefined {
        const stored = this.#topics.get(topic);
        return stored === undefined ? undefined : this.#listPage(stored, cursor, limit);
    }

    async readEvents(
        topic: string,
        since: bigint,
        limit?: number,
        wait?: number,
        signal?: AbortSignal,
    ): Promise<EventPage | undefined> {
        const page = this.#readEventsNow(topic, since, limit);
        if (page === undefined || page.events.length > 0 || wait === undefined || wait <= 0) {
            return page;
        }
        await this.#waitForChange(wait, signal);
        return this.#readEventsNow(topic, since, limit);
    }

    putBlob(blob: RelayBlob): void {
        if (blob.bytes.length > MAX_RELAY_BLOB_BYTES) throw new Error("Relay blob is too large");
        if (!verifyRelayBlob(blob)) throw new Error("Relay blob content address is invalid");
        this.#blobs.set(blob.id, blob.bytes.slice());
    }

    getBlob(id: string, expectedBytes?: number): RelayBlob | undefined {
        const bytes = this.#blobs.get(id);
        if (bytes === undefined) return undefined;
        if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
            throw new Error("Relay blob length does not match the expected ciphertext length");
        }
        return { bytes: bytes.slice(), id };
    }

    #readEventsNow(topic: string, since: bigint, limit?: number): EventPage | undefined {
        const stored = this.#topics.get(topic);
        if (stored === undefined) return undefined;
        const pageLimit = limit ?? DEFAULT_PAGE_LIMIT;
        const events = stored.events
            .filter((retained) => retained.seq > since)
            .slice(0, pageLimit)
            .map((retained) => ({ event: retained.event, seq: retained.seq }));
        // Every event is retained, so a caller's cursor can never fall out of history.
        return { events, reset: false, seq: stored.seq };
    }

    #listPage(topic: StoredTopic, cursor: string | undefined, limit?: number): ListPage {
        const ordered = [...topic.list.entries()].sort(
            ([, left], [, right]) => left.order - right.order,
        );
        const start = cursor === undefined ? 0 : ordered.findIndex(([id]) => id === cursor) + 1;
        const pageLimit = limit ?? DEFAULT_PAGE_LIMIT;
        const page = ordered.slice(start, start + pageLimit);
        const nextIndex = start + page.length;
        return {
            elements: page.map(([id, element]) => ({
                bytes: element.bytes.slice(),
                id,
                version: element.version,
            })),
            nextCursor: nextIndex < ordered.length ? (page.at(-1)?.[0] ?? null) : null,
        };
    }

    #wake(): void {
        const waiters = [...this.#waiters];
        this.#waiters.clear();
        for (const waiter of waiters) waiter();
    }

    async #waitForChange(wait: number, signal?: AbortSignal): Promise<void> {
        await new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
                if (settled) return;
                settled = true;
                this.#waiters.delete(finish);
                clearTimeout(timer);
                signal?.removeEventListener("abort", finish);
                resolve();
            };
            const timer = setTimeout(finish, wait);
            timer.unref?.();
            this.#waiters.add(finish);
            signal?.addEventListener("abort", finish, { once: true });
            if (signal?.aborted === true) finish();
        });
    }
}
