// Waiting is cheap and polling is not: every wait that times out costs another full model turn over
// the entire context. A wait returns the moment a subagent changes status, and new input or a
// finished background agent interrupts it, so the default is the maximum rather than a poll
// interval.
export const DEFAULT_SUBAGENT_WAIT_TIMEOUT_MS = 3_600_000;
export const MAX_SUBAGENT_WAIT_TIMEOUT_MS = 3_600_000;
export const MIN_SUBAGENT_WAIT_TIMEOUT_MS = 60_000;
