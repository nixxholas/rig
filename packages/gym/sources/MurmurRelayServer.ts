import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
    decodeSignedRelayEventWire,
    encodeBase64Url,
    signedRelayEventToJson,
    MAX_RELAY_BLOB_BYTES,
    type EventPage,
    type ListElement,
    type ListPage,
    type PublishOutcome,
    type TopicState,
} from "@slopus/murmur";

import { InMemoryMurmurRelay } from "../../rig/sources/murmur/InMemoryMurmurRelay.js";

const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const BLOB_LINK_LIFETIME_MS = 5 * 60 * 1000;

/**
 * A real, in-process HTTP server that speaks the exact wire protocol
 * `HttpRelayTransport` (from `@slopus/murmur`) expects, backed by
 * `InMemoryMurmurRelay`. It lets end-to-end tests run a real Murmur client
 * against a real relay over real HTTP without any external network.
 */
export class MurmurRelayServer {
    readonly url: string;
    readonly #server: Server;

    private constructor(server: Server, url: string) {
        this.#server = server;
        this.url = url;
    }

    /** Start a relay server bound to an ephemeral port on 127.0.0.1. */
    static async start(options?: { host?: string }): Promise<MurmurRelayServer> {
        const host = options?.host ?? "127.0.0.1";
        const relay = new InMemoryMurmurRelay();
        const server = createServer((req, res) => {
            void handleRequest(relay, req, res);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, host, () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Murmur relay server failed to bind a TCP port");
        }
        return new MurmurRelayServer(server, `http://${host}:${String(address.port)}`);
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.#server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });
    }
}

async function handleRequest(
    relay: InMemoryMurmurRelay,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    try {
        const host = req.headers.host ?? "127.0.0.1";
        const requestUrl = new URL(req.url ?? "/", `http://${host}`);
        const method = req.method ?? "GET";
        const path = requestUrl.pathname;

        const topicEvents = /^\/v1\/topics\/([^/]+)\/events$/.exec(path);
        if (topicEvents) {
            const topic = decodeURIComponent(topicEvents[1]!);
            if (method === "POST") {
                await handlePublish(relay, req, res);
                return;
            }
            if (method === "GET") {
                await handleReadEvents(relay, topic, requestUrl, req, res);
                return;
            }
        }

        const topicState = /^\/v1\/topics\/([^/]+)\/state$/.exec(path);
        if (topicState && method === "GET") {
            handleReadState(relay, decodeURIComponent(topicState[1]!), requestUrl, res);
            return;
        }

        const topicList = /^\/v1\/topics\/([^/]+)\/list$/.exec(path);
        if (topicList && method === "GET") {
            handleReadList(relay, decodeURIComponent(topicList[1]!), requestUrl, res);
            return;
        }

        const blobUploadLink = /^\/v1\/blobs\/([^/]+)\/upload-link$/.exec(path);
        if (blobUploadLink && method === "POST") {
            const id = decodeURIComponent(blobUploadLink[1]!);
            sendJson(res, 200, blobLinkJson("PUT", blobDataUrl(requestUrl, id)));
            return;
        }

        const blobDownloadLink = /^\/v1\/blobs\/([^/]+)\/download-link$/.exec(path);
        if (blobDownloadLink && method === "POST") {
            const id = decodeURIComponent(blobDownloadLink[1]!);
            if (relay.getBlob(id) === undefined) {
                sendText(res, 404, "Relay blob not found");
                return;
            }
            sendJson(res, 200, blobLinkJson("GET", blobDataUrl(requestUrl, id)));
            return;
        }

        const blobData = /^\/v1\/blobs\/([^/]+)\/data$/.exec(path);
        if (blobData) {
            const id = decodeURIComponent(blobData[1]!);
            if (method === "PUT") {
                await handleBlobUpload(relay, id, req, res);
                return;
            }
            if (method === "GET") {
                handleBlobDownload(relay, id, res);
                return;
            }
        }

        sendText(res, 404, "Relay route not found");
    } catch (error) {
        sendText(res, 500, describeError(error));
    }
}

async function handlePublish(
    relay: InMemoryMurmurRelay,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    let event;
    try {
        event = decodeSignedRelayEventWire(await readRequestBody(req));
    } catch (error) {
        sendText(res, 400, describeError(error));
        return;
    }
    try {
        sendJson(res, 200, publishOutcomeJson(relay.publish(event)));
    } catch (error) {
        sendText(res, 400, describeError(error));
    }
}

function handleReadState(
    relay: InMemoryMurmurRelay,
    topic: string,
    requestUrl: URL,
    res: ServerResponse,
): void {
    const limit = parseOptionalLimit(requestUrl, res);
    if (limit === PARSE_ERROR) return;
    const state = relay.readState(topic, limit);
    if (state === undefined) {
        sendText(res, 404, "Relay topic not found");
        return;
    }
    sendJson(res, 200, topicStateJson(state));
}

function handleReadList(
    relay: InMemoryMurmurRelay,
    topic: string,
    requestUrl: URL,
    res: ServerResponse,
): void {
    const limit = parseOptionalLimit(requestUrl, res);
    if (limit === PARSE_ERROR) return;
    const cursor = requestUrl.searchParams.get("cursor") ?? undefined;
    const page = relay.readList(topic, cursor, limit);
    if (page === undefined) {
        sendText(res, 404, "Relay topic not found");
        return;
    }
    sendJson(res, 200, listPageJson(page));
}

async function handleReadEvents(
    relay: InMemoryMurmurRelay,
    topic: string,
    requestUrl: URL,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    const sinceParameter = requestUrl.searchParams.get("since");
    if (sinceParameter === null || !/^\d+$/.test(sinceParameter)) {
        sendText(res, 400, "Invalid since parameter");
        return;
    }
    const since = BigInt(sinceParameter);
    const limit = parseOptionalLimit(requestUrl, res);
    if (limit === PARSE_ERROR) return;
    const waitParameter = requestUrl.searchParams.get("wait");
    let wait: number | undefined;
    if (waitParameter !== null) {
        wait = Number(waitParameter);
        if (!Number.isFinite(wait) || wait < 0) {
            sendText(res, 400, "Invalid wait parameter");
            return;
        }
    }

    // A long poll can outlive the caller's interest, so an aborted client
    // connection must cancel the relay's wait instead of leaking a timer.
    const controller = new AbortController();
    let responded = false;
    const onClose = (): void => {
        if (!responded) controller.abort();
    };
    req.on("close", onClose);
    try {
        const page = await relay.readEvents(topic, since, limit, wait, controller.signal);
        responded = true;
        req.off("close", onClose);
        if (page === undefined) {
            sendText(res, 404, "Relay topic not found");
            return;
        }
        sendJson(res, 200, eventPageJson(page));
    } catch (error) {
        responded = true;
        req.off("close", onClose);
        sendText(res, 400, describeError(error));
    }
}

async function handleBlobUpload(
    relay: InMemoryMurmurRelay,
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    let bytes;
    try {
        bytes = await readRequestBody(req, MAX_RELAY_BLOB_BYTES + 1);
    } catch (error) {
        sendText(res, 400, describeError(error));
        return;
    }
    try {
        relay.putBlob({ bytes, id });
        sendText(res, 200, "");
    } catch (error) {
        sendText(res, 400, describeError(error));
    }
}

function handleBlobDownload(relay: InMemoryMurmurRelay, id: string, res: ServerResponse): void {
    const blob = relay.getBlob(id);
    if (blob === undefined) {
        sendText(res, 404, "Relay blob not found");
        return;
    }
    sendBytes(res, 200, blob.bytes);
}

function blobDataUrl(requestUrl: URL, id: string): string {
    return `${requestUrl.origin}/v1/blobs/${encodeURIComponent(id)}/data`;
}

function blobLinkJson(
    method: "GET" | "PUT",
    url: string,
): { readonly url: string; readonly method: "GET" | "PUT"; readonly expiresAt: number } {
    return { expiresAt: Date.now() + BLOB_LINK_LIFETIME_MS, method, url };
}

const PARSE_ERROR = Symbol("relay-parse-error");

/** Reads an optional non-negative integer `limit` query parameter, sending a 400 on failure. */
function parseOptionalLimit(
    requestUrl: URL,
    res: ServerResponse,
): number | undefined | typeof PARSE_ERROR {
    const raw = requestUrl.searchParams.get("limit");
    if (raw === null) return undefined;
    const limit = Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 0) {
        sendText(res, 400, "Invalid limit parameter");
        return PARSE_ERROR;
    }
    return limit;
}

async function readRequestBody(
    req: IncomingMessage,
    maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
        total += chunk.length;
        if (total > maxBytes) {
            throw new Error("Relay request body is too large");
        }
        chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks, total));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
}

function sendText(res: ServerResponse, status: number, message: string): void {
    const body = Buffer.from(message, "utf8");
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
}

function sendBytes(res: ServerResponse, status: number, bytes: Uint8Array): void {
    res.writeHead(status, { "content-type": "application/octet-stream" });
    res.end(Buffer.from(bytes));
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown relay error";
}

// The wire shapes below are not exported as encoders by @slopus/murmur (only their decoders
// are), so they are derived field-for-field from `wireCodec.js`'s `listPageFromUnknown`,
// `decodeTopicStateWire`, `decodeEventPageWire`, and `decodePublishOutcomeWire`: bigints are
// decimal strings, byte arrays are unpadded base64url via `encodeBase64Url`, and every object
// carries exactly the field set its decoder requires (no extra keys, since decoders reject them).

function listElementJson(element: ListElement): { id: string; version: string; bytes: string } {
    return {
        bytes: encodeBase64Url(element.bytes),
        id: element.id,
        version: element.version.toString(),
    };
}

function listPageJson(page: ListPage): {
    elements: readonly { id: string; version: string; bytes: string }[];
    nextCursor: string | null;
} {
    return { elements: page.elements.map(listElementJson), nextCursor: page.nextCursor };
}

function topicStateJson(state: TopicState): {
    seq: string;
    snapshot: { version: string; bytes: string } | null;
    list: ReturnType<typeof listPageJson>;
} {
    return {
        list: listPageJson(state.list),
        seq: state.seq.toString(),
        snapshot:
            state.snapshot === null
                ? null
                : {
                      bytes: encodeBase64Url(state.snapshot.bytes),
                      version: state.snapshot.version.toString(),
                  },
    };
}

function eventPageJson(page: EventPage): unknown {
    return {
        events: page.events.map((retained) => ({
            ...signedRelayEventToJson(retained.event),
            seq: retained.seq.toString(),
        })),
        reset: page.reset,
        seq: page.seq.toString(),
    };
}

function publishOutcomeJson(outcome: PublishOutcome): unknown {
    return {
        duplicate: outcome.duplicate,
        seq: outcome.seq.toString(),
        ...(outcome.snapshotVersion === undefined
            ? {}
            : { snapshotVersion: outcome.snapshotVersion.toString() }),
    };
}
