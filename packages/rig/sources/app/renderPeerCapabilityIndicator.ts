import { truncateToWidth } from "@earendil-works/pi-tui";

import type { SessionSharedMetadata } from "../protocol/index.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/**
 * What any member with an active capability may currently do, in one English phrase.
 *
 * Read from `activeCapabilitiesDescription`, which the daemon computes from what members
 * actually hold right now, never from `offerableCapabilities` (what the project could merely
 * offer). The two can legitimately disagree — a grant survives the project later losing its
 * container — so building this from the offer would print a sentence that describes nobody's
 * actual access, or an empty one for a grant that is still very much live.
 */
export function describeActivePeerCapabilities(share: SessionSharedMetadata): string {
    return share.activeCapabilitiesDescription;
}

/**
 * The one row that stands for every member who currently holds a capability.
 *
 * The owner must never be able to forget that somebody is attached, so this row is present for
 * as long as `capabilityMemberCount` is above zero and never grows past one truncated line no
 * matter how many members or capabilities are involved.
 */
export function renderPeerCapabilityIndicator(
    share: SessionSharedMetadata | undefined,
    width: number,
): string | undefined {
    if (share === undefined || share.capabilityMemberCount === 0) return undefined;

    const plural = share.capabilityMemberCount === 1 ? "" : "s";
    const summary = `  ${String(share.capabilityMemberCount)} member${plural} can ${describeActivePeerCapabilities(share)} in this session`;
    return truncateToWidth(`${DIM}${summary}${RESET}`, Math.max(1, width), "", true);
}
