import type { IncomingMessage, ServerResponse } from "node:http";

import {
    LIVE_GLOBAL_EVENT_GAP,
    type LiveGlobalEventEntry,
    type LiveGlobalEventQueue,
} from "./LiveGlobalEventQueue.js";
import { sendJson } from "./sendJson.js";

/**
 * Bytes Node may hold for one subscriber before it is treated as stuck.
 *
 * A subscriber past this is disconnected rather than buffered without bound. It
 * reconnects, is told a gap was detected, and reloads — which is the ordinary
 * recovery path here, not a failure.
 */
const SUBSCRIBER_BUFFER_LIMIT = 1024 * 1024;

/**
 * The one subscription a local client needs.
 *
 * The stream carries light updates only: an event, and the cursor that orders
 * it. Sessions, projects, workspaces and users never travel inside it — they are
 * fetched by request-response and then followed here, so the same object is not
 * repeated a hundred times over.
 *
 * A client attaching without a cursor is given the current position and nothing
 * else, which is what lets it open the stream first and load entities second:
 * anything that happens during the load arrives on a cursor it can compare
 * against what it loaded.
 */
export function streamLiveEvents(
    request: IncomingMessage,
    response: ServerResponse,
    queue: LiveGlobalEventQueue,
    afterValue: string | null,
): void {
    const lastEventId = request.headers["last-event-id"];
    const headerCursor = Array.isArray(lastEventId) ? lastEventId.at(-1) : lastEventId;
    const after = headerCursor ?? afterValue ?? undefined;
    if (after !== undefined && !isCursor(after)) {
        sendJson(response, 400, { error: "The event cursor is invalid." });
        return;
    }

    // The replay is taken before the headers go out, so a cursor this queue
    // cannot serve is still a plain answer rather than a frame on an open
    // stream. It is read before the subscription for the opposite reason: an
    // event landing in between is delivered twice, never lost, and a repeat is
    // harmless because the client compares cursors.
    const replay = after === undefined ? [] : queue.since(after);
    const gap = replay === LIVE_GLOBAL_EVENT_GAP;
    const missed: readonly LiveGlobalEventEntry[] = gap ? [] : replay;

    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");

    // `resumed` distinguishes a stream that continued from one that restarted.
    // A gap is not an error: it tells the client to re-fetch what it holds.
    writeFrame(response, "hello", {
        cursor: gap || after === undefined ? queue.cursor() : after,
        gap,
        resumed: after !== undefined && !gap,
    });

    let closed = false;
    let unsubscribe = () => {};
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    heartbeat.unref?.();
    const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
    };

    // A gap already told the client to reload, so replaying into it would only
    // race that reload with events it is about to fetch anyway.
    if (!gap) {
        for (const entry of missed) writeUpdate(response, entry);
        if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) {
            close();
            return;
        }
    }

    unsubscribe = queue.subscribe((entry) => {
        if (closed) return;
        writeUpdate(response, entry);
        if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) close();
    }, close);

    request.on("close", close);
}

/**
 * Whether a cursor could have come from this stream.
 *
 * Only the shape is checked here; whether the position is still retained is the
 * queue's answer, and it is a gap rather than a refusal.
 */
function isCursor(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function writeUpdate(response: ServerResponse, entry: LiveGlobalEventEntry): void {
    // The SSE id is the stream's cursor, so a browser EventSource reconnecting
    // on its own resumes from exactly the position this stream understands.
    response.write(`id: ${entry.cursor}\n`);
    writeFrame(response, "update", { cursor: entry.cursor, event: entry.event });
}

function writeFrame(response: ServerResponse, name: string, data: unknown): boolean {
    response.write(`event: ${name}\n`);
    return response.write(`data: ${JSON.stringify(data)}\n\n`);
}
