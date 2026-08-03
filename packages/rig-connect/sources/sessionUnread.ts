import type { SessionEvent, SessionUnreadState } from "./protocol.js";

/**
 * The unread state a chat is left in by one event.
 *
 * The daemon stores unread state and reports it on every session summary, but
 * it publishes no event saying the state changed: the transition rides on the
 * events that caused it. So a client watching live derives the same answer from
 * the same events, and the summary it loads on connect or reconnect is what
 * puts that derivation back on the daemon's footing.
 *
 * This mirrors the daemon's own rule deliberately, and
 * `tests/sessionUnread.test.ts` runs both over the same events to keep them
 * from drifting apart.
 */
export function sessionUnreadAfterEvent(
    current: SessionUnreadState | undefined,
    event: SessionEvent,
): SessionUnreadState | undefined {
    if (event.type === "user_input_requested" || event.type === "external_tool_call_requested") {
        return { reason: "attention_needed", since: event.createdAt };
    }
    if (
        event.type === "message_submitted" &&
        (event.data as { delivery?: unknown }).delivery === "context" &&
        (event.data as { message?: { friendAuthor?: unknown } }).message?.friendAuthor !== undefined
    ) {
        if (current?.reason === "attention_needed") return current;
        return { reason: "friend_message", since: event.createdAt };
    }
    if (event.type !== "run_finished" && event.type !== "run_error") return current;
    if (current?.reason === "attention_needed" || current?.reason === "friend_message") {
        return current;
    }
    return { reason: "turn_finished", since: event.createdAt };
}
