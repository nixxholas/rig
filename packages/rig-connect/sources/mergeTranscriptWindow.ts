import type { Message, SessionTranscriptWindow } from "./protocol.js";

/**
 * Combines the turns a client already holds with a freshly delivered window.
 *
 * A stream that reconnects without a usable cursor is answered with the newest
 * turns only. Taking that answer literally would delete rows off the top of a
 * conversation somebody is reading, so the older turns already loaded are kept
 * in front of it.
 *
 * The fresh window is authoritative wherever the two overlap, and a window that
 * declares itself complete replaces everything: retaining older turns then would
 * resurrect turns a reset or a rewind removed.
 */
export function mergeTranscriptWindow(
    loaded: SessionTranscriptWindow | undefined,
    incoming: SessionTranscriptWindow,
): SessionTranscriptWindow {
    if (loaded === undefined || incoming.complete || incoming.turns.length === 0) return incoming;

    const [oldestIncoming] = incoming.turns;
    if (oldestIncoming === undefined) return incoming;
    const fresh = new Set(incoming.turns.map((turn) => turn.runId));
    // Anything the fresh window reaches is the fresh window's to describe. Only
    // turns that start before it can be retained, so a turn it dropped stays
    // dropped rather than coming back.
    const retained = loaded.turns.filter(
        (turn) => !fresh.has(turn.runId) && turn.startedAt < oldestIncoming.startedAt,
    );
    if (retained.length === 0) return incoming;

    const keep = new Set(retained.flatMap((turn) => turn.messageIds));
    const messages: Message[] = loaded.messages.filter((message) => keep.has(message.id));
    const known = new Set(messages.map((message) => message.id));
    for (const message of incoming.messages) {
        if (known.has(message.id)) continue;
        known.add(message.id);
        messages.push(message);
    }
    const messageCreatedAt = Object.fromEntries(
        messages.flatMap((message) => {
            const createdAt =
                incoming.messageCreatedAt?.[message.id] ?? loaded.messageCreatedAt?.[message.id];
            return createdAt === undefined ? [] : [[message.id, createdAt]];
        }),
    );

    return {
        // The retained turns reach back to where the earlier window started, so
        // the merged window is complete only if that one was.
        complete: loaded.complete,
        ...(Object.keys(messageCreatedAt).length === 0 ? {} : { messageCreatedAt }),
        messages,
        turns: [...retained, ...incoming.turns],
    };
}
