import type { Usage } from "@slopus/rig-execution";

import type { EventId } from "../../../protocol/index.js";
import type { PersistedSessionState } from "../../../server/InMemorySession.js";
import type { SessionUsageSummary } from "../../../server/sessionUsage/index.js";

export interface PersistedUsageEnvelope {
    committed: Usage;
    permissionReviews?: PersistedSessionState["permissionReviews"];
    summary?: SessionUsageSummary;
    throughEventId?: EventId;
}

export function parsePersistedUsage(value: string | undefined): PersistedUsageEnvelope | undefined {
    if (value === undefined) return undefined;
    const parsed = JSON.parse(value) as Usage | PersistedUsageEnvelope;
    return "committed" in parsed ? parsed : { committed: parsed };
}
