import type { SessionEvent } from "../protocol/index.js";
import { isTransientInferenceSessionEvent } from "./isTransientInferenceSessionEvent.js";

/**
 * Events that are delivered to attached clients but never written to the
 * durable event log.
 *
 * Inference stream updates are superseded by the completed message. Composer
 * drafts change on every keystroke burst and their latest value already lives
 * on the session row, so a client that reconnects reads the draft from the
 * session snapshot instead of replaying every intermediate edit.
 */
export function isLiveOnlySessionEvent(event: SessionEvent): boolean {
    return event.type === "session_draft_changed" || isTransientInferenceSessionEvent(event);
}
