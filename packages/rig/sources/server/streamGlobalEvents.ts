import type { IncomingMessage, ServerResponse } from "node:http";

import type { GlobalLiveEvent } from "../protocol/index.js";
import type { GlobalEventQueue } from "./GlobalEventQueue.js";
import { parseGlobalEventCursor } from "./parseGlobalEventCursor.js";
import { sendJson } from "./sendJson.js";
import { writeGlobalSseEvent } from "./writeGlobalSseEvent.js";

export function streamGlobalEvents(
    request: IncomingMessage,
    response: ServerResponse,
    queue: GlobalEventQueue,
    afterValue: string | null,
    /** Current live snapshots, replayed on subscribe because live events are never stored. */
    liveSnapshots?: () => readonly GlobalLiveEvent[],
): void {
    const lastEventId = request.headers["last-event-id"];
    const cursorValue = Array.isArray(lastEventId) ? lastEventId.at(-1) : lastEventId;
    const selectedValue = cursorValue ?? afterValue;
    const after = parseGlobalEventCursor(selectedValue ?? null);
    if (selectedValue !== undefined && selectedValue !== null && after === undefined) {
        sendJson(response, 400, { error: "The event cursor is invalid." });
        return;
    }

    const catchupLimit = 1_000;
    let catchup = queue.list({
        ...(after === undefined ? {} : { after }),
        limit: catchupLimit,
    });
    if (catchup === undefined) {
        sendJson(response, 409, { error: "The global event cursor is not available." });
        return;
    }

    response.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");

    let overwhelmed = false;
    for (;;) {
        for (const entry of catchup) writeGlobalSseEvent(response, entry);
        // Replaying an untrimmed durable log to a slow reader would buffer the whole thing into
        // this response in one synchronous pass, which is exactly what the subscriber limit exists
        // to prevent. The client re-bootstraps from /state, the documented recovery path.
        if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) {
            overwhelmed = true;
            break;
        }
        if (catchup.length < catchupLimit) break;
        const nextCursor: string | undefined = catchup.at(-1)?.cursor;
        if (nextCursor === undefined) break;
        catchup = queue.list({ after: nextCursor, limit: catchupLimit }) ?? [];
    }
    if (overwhelmed) {
        response.end();
        return;
    }

    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    heartbeat.unref?.();
    let closed = false;
    let unsubscribe = () => {};

    // One live snapshot per entity is retained while the socket is backed up, and a later snapshot
    // replaces the pending one. Stored events are never coalesced or dropped; only live snapshots
    // are, and they are safe to drop because each one supersedes the last.
    const pendingLive = new Map<string, GlobalLiveEvent>();
    let backedUp = false;
    const flushLive = () => {
        // Without this guard a drain arriving after close would write to an ended response, which
        // surfaces as an uncaught daemon exception. Today only a Node internal prevents it.
        if (closed) return;
        backedUp = false;
        // Copied first because the loop deletes from the map it iterates.
        for (const [key, event] of Array.from(pendingLive)) {
            pendingLive.delete(key);
            if (!writeGlobalSseEvent(response, { event, live: true })) {
                backedUp = true;
                break;
            }
        }
    };
    const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        response.off("drain", flushLive);
        pendingLive.clear();
        response.end();
    };
    response.on("drain", flushLive);

    unsubscribe = queue.subscribe((delivery) => {
        if (closed) return;
        if ("live" in delivery) {
            const key = liveEventKey(delivery.event);
            if (backedUp) {
                pendingLive.set(key, delivery.event);
                if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) close();
                return;
            }
            backedUp = !writeGlobalSseEvent(response, delivery);
            return;
        }
        // Stored events are never coalesced or dropped, so a subscriber that cannot keep up with
        // them is disconnected and reloads from /state instead of growing the buffer without bound.
        if (!writeGlobalSseEvent(response, delivery)) backedUp = true;
        if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) close();
    }, close);

    // Subscribing before capturing the current snapshots is what makes this gapless: capturing
    // first would drop any snapshot published in between.
    for (const event of liveSnapshots?.() ?? []) {
        if (backedUp) {
            // Held rather than written, so a slow reconnecting subscriber cannot be handed every
            // snapshot at once and buffer past the limit the streaming path already respects.
            pendingLive.set(liveEventKey(event), event);
            continue;
        }
        backedUp = !writeGlobalSseEvent(response, { event, live: true });
    }
    if (response.writableLength > SUBSCRIBER_BUFFER_LIMIT) close();
    request.on("close", close);
}

/**
 * Bytes Node may hold for one subscriber before it is treated as stuck. Counting pending entities
 * instead would be unreachable in practice, because the tracker holds fewer entities than any
 * sensible entity cap, while the socket buffer is what actually grows.
 */
const SUBSCRIBER_BUFFER_LIMIT = 1024 * 1024;

function liveEventKey(event: GlobalLiveEvent): string {
    return "workspaceId" in event ? `workspace:${event.workspaceId}` : `project:${event.projectId}`;
}
