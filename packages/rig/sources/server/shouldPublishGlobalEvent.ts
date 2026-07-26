import { isLiveGlobalEvent, type GlobalEvent } from "../protocol/index.js";
import { shouldPersistGlobalEventType } from "./shouldPersistGlobalEventType.js";

/**
 * Whether an event belongs in the stored global stream.
 *
 * Live events are excluded here so they can never reach `append` by accident; they travel through
 * `publishLive` instead and are never written to the durable log.
 */
export function shouldPublishGlobalEvent(event: GlobalEvent): boolean {
    if (isLiveGlobalEvent(event)) return false;
    return !("sessionId" in event) || shouldPersistGlobalEventType(event.type);
}
