import type { GlobalEvent, GlobalEventQueueEntry } from "../protocol/index.js";

export function parseGlobalSseEvent(raw: string): GlobalEventQueueEntry | undefined {
    if (raw.startsWith(":")) return undefined;

    const lines = raw.split("\n");
    const id = lines
        .find((line) => line.startsWith("id:"))
        ?.slice("id:".length)
        .trim();
    const cursor = id;
    const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart());
    if (cursor === undefined || dataLines.length === 0) {
        return undefined;
    }

    return {
        cursor,
        event: JSON.parse(dataLines.join("\n")) as GlobalEvent,
    };
}
