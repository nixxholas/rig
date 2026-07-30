import type { GlobalLiveEvent } from "../protocol/index.js";
import type { SessionStore } from "./SessionStore.js";

export function publishGitLiveEvent(store: SessionStore, event: GlobalLiveEvent): boolean {
    store.liveEvents.publish(event);
    return store.globalEventQueue.publishLive(event);
}
