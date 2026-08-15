import type { GlobalLiveEvent } from "../protocol/index.js";
import type { GlobalEventQueue } from "../global-event/GlobalEventQueue.js";
import type { LiveGlobalEventQueue } from "../global-event/LiveGlobalEventQueue.js";

export function publishGitLiveEvent(
    events: { global: GlobalEventQueue; live: LiveGlobalEventQueue },
    event: GlobalLiveEvent,
): boolean {
    events.live.publish(event);
    return events.global.publishLive(event);
}
