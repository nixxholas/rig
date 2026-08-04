import { truncateToWidth } from "@earendil-works/pi-tui";

import type { SessionSharedMetadata } from "../protocol/index.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/**
 * What any member with an active capability may currently do, in one English phrase.
 *
 * Built from the share's own `offerableCapabilities` labels rather than a capability code, so
 * nothing here can ever print an enum literal such as `terminal_view`.
 */
export function describeActivePeerCapabilities(share: SessionSharedMetadata): string {
    const labels = share.offerableCapabilities
        .filter((capability) => capability.offerable)
        .map((capability) => capability.label.charAt(0).toLowerCase() + capability.label.slice(1));
    if (labels.length === 0) return "a capability";
    if (labels.length === 1) return labels[0]!;
    return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;
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
