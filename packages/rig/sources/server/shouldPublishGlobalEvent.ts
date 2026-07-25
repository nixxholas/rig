import type { GlobalEvent } from "../protocol/index.js";
import { shouldPersistGlobalEventType } from "./shouldPersistGlobalEventType.js";

export function shouldPublishGlobalEvent(event: GlobalEvent): boolean {
    return !("sessionId" in event) || shouldPersistGlobalEventType(event.type);
}
