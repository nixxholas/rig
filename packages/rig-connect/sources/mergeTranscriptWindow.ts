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
    // A search the provider ran is carried only here: Rig never executed one, so no assistant
    // message records it and dropping it on a merge deletes it from a conversation already on
    // screen. Identity is the call, and the fresh window wins wherever the two hold the same one.
    const providerToolCallsById = new Map(
        (loaded.providerToolCalls ?? []).map((call) => [call.callId, call]),
    );
    for (const call of incoming.providerToolCalls ?? []) {
        providerToolCallsById.set(call.callId, call);
    }
    const providerToolCalls = [...providerToolCallsById.values()].sort(
        (left, right) => left.createdAt - right.createdAt,
    );
    const noticesById = new Map(
        (loaded.notices ?? []).map((notice) => [notice.message.id, notice]),
    );
    for (const notice of incoming.notices ?? []) noticesById.set(notice.message.id, notice);
    const notices = [...noticesById.values()].sort(
        (left, right) =>
            left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId),
    );

    return {
        complete: loaded.complete || incoming.complete,
        ...(Object.keys(messageCreatedAt).length === 0 ? {} : { messageCreatedAt }),
        ...(Object.keys(messageEventId).length === 0 ? {} : { messageEventId }),
        ...(Object.keys(messageSteeredAt).length === 0 ? {} : { messageSteeredAt }),
        ...(Object.keys(messageBoundaryGroupId).length === 0 ? {} : { messageBoundaryGroupId }),
        ...(Object.keys(messageGroupId).length === 0 ? {} : { messageGroupId }),
        ...(permissionReviews.length === 0 ? {} : { permissionReviews }),
        ...(providerToolCalls.length === 0 ? {} : { providerToolCalls }),
        messages,
        ...(notices.length === 0 ? {} : { notices }),
        ...(loaded.noticesTruncated === true || incoming.noticesTruncated === true
            ? { noticesTruncated: true }
            : {}),
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
    if (incoming.turns.length === 0 && (incoming.notices?.length ?? 0) === 0) {
        return { ...loaded, complete: historyComplete };
    }
    return {
        ...mergeTranscriptWindow(loaded, { ...incoming, complete: false }),
        complete: historyComplete,
    };
}
