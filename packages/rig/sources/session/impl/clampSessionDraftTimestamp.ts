import { SESSION_DRAFT_MAX_CLOCK_SKEW_MS } from "../../protocol/index.js";

/**
 * Resolves the moment a composer draft was typed, on the daemon's clock.
 *
 * Clients stamp a draft when the user types it so a write that was created
 * earlier cannot replace a newer one just by arriving later. The stamp comes
 * from the writing machine's clock, so it is clamped before it is trusted: a
 * draft can never be created in the future, and one from a clock far in the
 * past is treated as recent enough to still be ordered against other clients
 * instead of being permanently unable to win.
 */
export function clampSessionDraftTimestamp(supplied: number | undefined, now: number): number {
    if (supplied === undefined || !Number.isFinite(supplied)) return now;
    return Math.min(Math.max(Math.trunc(supplied), now - SESSION_DRAFT_MAX_CLOCK_SKEW_MS), now);
}
