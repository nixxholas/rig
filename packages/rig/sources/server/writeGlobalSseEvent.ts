import type { ServerResponse } from "node:http";

import type { GlobalEventDelivery } from "../protocol/index.js";

/**
 * Writes one global event to an SSE stream.
 *
 * A live delivery carries no `id:` line. Clients echo the last `id:` back as `Last-Event-Id`, so
 * giving a live event a cursor — real or invented — would either make a reconnect skip stored
 * events or make it reject a cursor it cannot resolve.
 *
 * Returns whether the socket accepted the write without buffering, so a caller can apply
 * backpressure rather than growing an unbounded queue behind a slow consumer.
 */
export function writeGlobalSseEvent(
    response: ServerResponse,
    delivery: GlobalEventDelivery,
): boolean {
    if (!("live" in delivery)) response.write(`id: ${delivery.cursor}\n`);
    response.write(`event: ${delivery.event.type}\n`);
    return response.write(`data: ${JSON.stringify(delivery.event)}\n\n`);
}
