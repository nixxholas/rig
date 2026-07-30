import type { Message, SessionTranscriptWindow } from "./protocol.js";

/**
 * Combines the turns a client already holds with a freshly delivered window.
 *
 * A stream that reconnects without a usable cursor is answered with the newest
 * turns only. Taking that answer literally would delete rows off the top of a
 * conversation somebody is reading, so the older turns already loaded are kept
 * in front of it.
 *
 * The fresh window is authoritative wherever the two overlap. Turns outside the
 * overlap are immutable history: reset and rewind can change the active model
 * context, but they do not delete turns the user has already seen.
 */
export function mergeTranscriptWindow(
    loaded: SessionTranscriptWindow | undefined,
    incoming: SessionTranscriptWindow,
): SessionTranscriptWindow {
    if (loaded === undefined) return incoming;

    const turnsById = new Map(loaded.turns.map((turn) => [turn.runId, turn]));
    for (const turn of incoming.turns) turnsById.set(turn.runId, turn);
    const turns = [...turnsById.values()].sort((left, right) => left.startedAt - right.startedAt);
    const messagesById = new Map(loaded.messages.map((message) => [message.id, message]));
    for (const message of incoming.messages) messagesById.set(message.id, message);
    const messages: Message[] = turns.flatMap((turn) =>
        turn.messageIds.flatMap((messageId) => {
            const message = messagesById.get(messageId);
            return message === undefined ? [] : [message];
        }),
    );
    const messageCreatedAt = Object.fromEntries(
        messages.flatMap((message) => {
            const createdAt =
                incoming.messageCreatedAt?.[message.id] ?? loaded.messageCreatedAt?.[message.id];
            return createdAt === undefined ? [] : [[message.id, createdAt]];
        }),
    );
    const messageEventId = Object.fromEntries(
        messages.flatMap((message) => {
            const eventId =
                incoming.messageEventId?.[message.id] ?? loaded.messageEventId?.[message.id];
            return eventId === undefined ? [] : [[message.id, eventId]];
        }),
    );
    const messageSteeredAt = Object.fromEntries(
        messages.flatMap((message) => {
            const steeredAt =
                incoming.messageSteeredAt?.[message.id] ?? loaded.messageSteeredAt?.[message.id];
            return steeredAt === undefined ? [] : [[message.id, steeredAt]];
        }),
    );
    const messageBoundaryGroupId = Object.fromEntries(
        messages.flatMap((message) => {
            const groupId =
                incoming.messageBoundaryGroupId?.[message.id] ??
                loaded.messageBoundaryGroupId?.[message.id];
            return groupId === undefined ? [] : [[message.id, groupId]];
        }),
    );
    const messageGroupId = Object.fromEntries(
        messages.flatMap((message) => {
            const groupId =
                incoming.messageGroupId?.[message.id] ?? loaded.messageGroupId?.[message.id];
            return groupId === undefined ? [] : [[message.id, groupId]];
        }),
    );
    const permissionReviews = [
        ...(loaded.permissionReviews ?? []),
        ...(incoming.permissionReviews ?? []),
    ].filter(
        (review, index, reviews) =>
            reviews.findLastIndex((candidate) => candidate.toolCallId === review.toolCallId) ===
            index,
    );

    return {
        complete: loaded.complete || incoming.complete,
        ...(Object.keys(messageCreatedAt).length === 0 ? {} : { messageCreatedAt }),
        ...(Object.keys(messageEventId).length === 0 ? {} : { messageEventId }),
        ...(Object.keys(messageSteeredAt).length === 0 ? {} : { messageSteeredAt }),
        ...(Object.keys(messageBoundaryGroupId).length === 0 ? {} : { messageBoundaryGroupId }),
        ...(Object.keys(messageGroupId).length === 0 ? {} : { messageGroupId }),
        ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
        messages,
        turns,
    };
}

/**
 * Appends a page loaded toward the newest end of a conversation.
 *
 * Forward paging overlaps by one turn so a client can replace a possibly partial
 * anchor turn. The incoming copy is authoritative for that overlap. Its
 * `complete` flag describes whether paging reached the newest turn, so callers
 * provide the history-completeness value that should remain visible afterward.
 */
export function mergeForwardTranscriptWindow(
    loaded: SessionTranscriptWindow | undefined,
    incoming: SessionTranscriptWindow,
    historyComplete: boolean,
): SessionTranscriptWindow {
    if (loaded === undefined) return { ...incoming, complete: historyComplete };
    if (incoming.turns.length === 0) return { ...loaded, complete: historyComplete };
    return {
        ...mergeTranscriptWindow(loaded, { ...incoming, complete: false }),
        complete: historyComplete,
    };
}
