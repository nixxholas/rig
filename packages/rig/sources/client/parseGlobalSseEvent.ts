import type { GlobalEvent, GlobalEventDelivery, GlobalLiveEvent } from "../protocol/index.js";
import { isLiveGlobalEvent } from "../protocol/index.js";

/**
 * Parses one SSE frame from the global stream.
 *
 * A live delivery carries no `id:` line, by design: its cursor would corrupt the client's
 * `Last-Event-Id`. Requiring an id here would silently discard every Git snapshot and make the
 * whole live channel unreachable through the supported client.
 */
export function parseGlobalSseEvent(raw: string): GlobalEventDelivery | undefined {
    if (raw.startsWith(":")) return undefined;

    const lines = raw.split("\n");
    const cursor = lines
        .find((line) => line.startsWith("id:"))
        ?.slice("id:".length)
        .trim();
    const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length === 0) return undefined;

    const event = JSON.parse(dataLines.join("\n")) as GlobalEvent;
    if (cursor === undefined) {
        return isLiveGlobalEvent(event)
            ? { event, live: true }
            : // A stored event without a cursor cannot be resumed from, so it is not usable.
              undefined;
    }
    return { cursor, event: event as Exclude<GlobalEvent, GlobalLiveEvent> };
}
